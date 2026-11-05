import { docker } from "./docker-cli.js";
import {
  CREATED_AT_LABEL,
  MANAGED_LABEL,
  ROLE_LABEL,
  SANDBOX_LABEL,
  SCOPE_LABEL,
} from "./labels.js";
import {
  forgetScope,
  listScopes,
  TERMINAL_STATUSES,
  type ScopeRecord,
} from "./registry.js";

/**
 * The sweeper that removes what the factory left behind.
 *
 * @remarks
 * Two rules, and they are the whole safety argument:
 *
 * 1. Only resources labelled `ia-factory.managed=true` are ever touched.
 *    A container or a volume without that label is invisible here, so the
 *    janitor can never remove something that belongs to somebody else on
 *    the same machine.
 * 2. A live task is never swept. A task is live while its registry record
 *    says so and its heartbeat is recent.
 *
 * Everything else is expired: the sandbox outlived its TTL and its task is
 * not working anymore.
 */

export interface JanitorOptions {
  /** How long a sandbox may live without a heartbeat. */
  readonly ttlMinutes: number;
  /** What to do with a resource that could not be removed. */
  readonly onError?: (message: string) => void;
}

export interface JanitorReport {
  readonly removedContainers: readonly string[];
  readonly removedVolumes: readonly string[];
  readonly failed: readonly string[];
}

interface DockerResource {
  readonly id: string;
  readonly labels: Record<string, string>;
}

/**
 * Lists the containers the factory manages.
 */
async function listManagedContainers(): Promise<DockerResource[]> {
  const ids = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=${MANAGED_LABEL}=true`,
  ]);
  if (ids.exitCode !== 0) {
    return [];
  }
  const resources: DockerResource[] = [];
  for (const id of ids.stdout.split("\n").filter((line) => line.trim() !== "")) {
    const inspected = await docker([
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      id.trim(),
    ]);
    if (inspected.exitCode !== 0) {
      continue;
    }
    try {
      resources.push({
        id: id.trim(),
        labels: JSON.parse(inspected.stdout.trim()) as Record<string, string>,
      });
    } catch {
      // A container whose labels do not parse is not one of ours.
    }
  }
  return resources;
}

/**
 * Lists the volumes the factory manages.
 */
async function listManagedVolumes(): Promise<DockerResource[]> {
  const listed = await docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=${MANAGED_LABEL}=true`,
  ]);
  if (listed.exitCode !== 0) {
    return [];
  }
  const resources: DockerResource[] = [];
  for (const name of listed.stdout.split("\n").filter((line) => line.trim() !== "")) {
    const inspected = await docker([
      "volume",
      "inspect",
      "--format",
      "{{json .Labels}}",
      name.trim(),
    ]);
    if (inspected.exitCode !== 0) {
      continue;
    }
    try {
      resources.push({
        id: name.trim(),
        labels: JSON.parse(inspected.stdout.trim()) as Record<string, string>,
      });
    } catch {
      // Not ours.
    }
  }
  return resources;
}

/**
 * Whether a scope is still working.
 */
function isScopeAlive(record: ScopeRecord | null): boolean {
  if (record === null) {
    return false;
  }
  return !TERMINAL_STATUSES.includes(record.status);
}

/**
 * Whether a resource outlived its TTL.
 *
 * @remarks
 * The clock is the scope's heartbeat when there is one, and the resource's
 * own creation date otherwise. The heartbeat is the honest clock: a task
 * that has been working for six hours is alive, even though its first
 * container is six hours old.
 */
function isExpired(
  labels: Readonly<Record<string, string>>,
  record: ScopeRecord | null,
  ttlMs: number,
): boolean {
  if (!isScopeAlive(record)) {
    return true;
  }
  const lastSeen =
    record?.lastHeartbeatAt ?? labels[CREATED_AT_LABEL];
  if (lastSeen === undefined) {
    // A factory resource with no timestamp is a bug, not a reason to keep it.
    return true;
  }
  const age = Date.now() - new Date(lastSeen).getTime();
  return Number.isFinite(age) && age > ttlMs;
}

/**
 * Whether a volume still has containers on it.
 *
 * @remarks
 * Docker refuses to remove a volume that is in use, so the janitor asks
 * first and leaves the volume alone. That is what keeps a sweep from
 * pulling the checkout out from under a sandbox that is still working.
 */
async function volumeInUse(volumeName: string): Promise<boolean> {
  const listed = await docker([
    "ps",
    "-aq",
    "--filter",
    `volume=${volumeName}`,
  ]);
  return listed.exitCode === 0 && listed.stdout.trim() !== "";
}

/**
 * Removes the factory's expired containers and volumes.
 *
 * @remarks
 * Safe to call at any time and safe to call twice: removing something that
 * is already gone is not an error.
 */
export async function sweep(
  options: JanitorOptions,
): Promise<JanitorReport> {
  const ttlMs = options.ttlMinutes * 60_000;
  const scopes = new Map(
    (await listScopes()).map((record) => [record.scopeId, record]),
  );

  const removedContainers: string[] = [];
  const removedVolumes: string[] = [];
  const failed: string[] = [];

  for (const container of await listManagedContainers()) {
    const scope = container.labels[SCOPE_LABEL];
    const record = scope === undefined ? null : (scopes.get(scope) ?? null);
    if (!isExpired(container.labels, record, ttlMs)) {
      continue;
    }
    const removed = await docker(["rm", "-f", container.id]);
    if (removed.exitCode === 0) {
      removedContainers.push(container.labels[SANDBOX_LABEL] ?? container.id);
    } else {
      failed.push(`container ${container.id}: ${removed.stderr.trim()}`);
    }
  }

  for (const volume of await listManagedVolumes()) {
    const scope = volume.labels[SCOPE_LABEL];
    const record = scope === undefined ? null : (scopes.get(scope) ?? null);
    if (!isExpired(volume.labels, record, ttlMs)) {
      continue;
    }
    if (await volumeInUse(volume.id)) {
      // Still mounted somewhere: a live sandbox is using it.
      continue;
    }
    const removed = await docker(["volume", "rm", volume.id]);
    if (removed.exitCode === 0) {
      removedVolumes.push(volume.id);
    } else {
      failed.push(`volume ${volume.id}: ${removed.stderr.trim()}`);
    }
  }

  // A scope that is over, or that has outlived its TTL, and whose resources
  // are gone, leaves nothing to remember.
  for (const record of scopes.values()) {
    if (!isExpired({}, record, ttlMs)) {
      continue;
    }
    const containersLeft = await docker([
      "ps",
      "-aq",
      "--filter",
      `label=${SCOPE_LABEL}=${record.scopeId}`,
    ]);
    if (containersLeft.stdout.trim() !== "") {
      continue;
    }
    await forgetScope(record.scopeId);
  }

  for (const message of failed) {
    options.onError?.(message);
  }

  return { removedContainers, removedVolumes, failed };
}

/**
 * Removes one container, for the cleanup routine of a terminal task.
 */
export async function removeContainer(containerId: string): Promise<boolean> {
  const result = await docker(["rm", "-f", containerId]);
  return result.exitCode === 0;
}

/**
 * Removes one volume, for the cleanup routine of a terminal task.
 */
export async function removeVolume(volumeId: string): Promise<boolean> {
  const result = await docker(["volume", "rm", volumeId]);
  return result.exitCode === 0;
}
