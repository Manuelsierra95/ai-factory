import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The host-side registry of factory scopes.
 *
 * @remarks
 * Docker labels are immutable, so they cannot carry a heartbeat. The
 * registry does: one small JSON file per scope under `.factory/scopes/`,
 * with the scope's status and the last time something happened in it.
 *
 * A **scope** is the root of a dispatch chain: the session the developer
 * talks to. Every station of a task belongs to the same scope, and the
 * scope is what the sandbox layer shares (one checkout per scope).
 *
 * The janitor reads the registry to decide what is still alive. The pipeline
 * writes the terminal status when a task ends.
 */

/** Where the registry lives, relative to the app root. */
const SCOPES_DIR = ".factory/scopes";

export type ScopeStatus =
  | "running"
  | "iterating"
  | "completed"
  | "failed"
  | "cancelled"
  | "escalated";

/** A scope that is over. Nothing of it needs to survive. */
export const TERMINAL_STATUSES: readonly ScopeStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "escalated",
];

export interface ScopeRecord {
  readonly scopeId: string;
  readonly status: ScopeStatus;
  readonly createdAt: string;
  /** Last time a sandbox of this scope did something. */
  readonly lastHeartbeatAt: string;
  /** Sandboxes this scope opened. */
  readonly sandboxes: readonly string[];
}

function registryRoot(): string {
  // The app root is the process working directory: eve runs the app from
  // `apps/ia-factory`, and the registry belongs to the app, not to the repo.
  return process.cwd();
}

function recordPath(scopeId: string): string {
  return join(registryRoot(), SCOPES_DIR, `${scopeId}.json`);
}

/**
 * Reads a scope record, or null when the scope is unknown.
 */
export async function readScope(
  scopeId: string,
): Promise<ScopeRecord | null> {
  try {
    const raw = await readFile(recordPath(scopeId), "utf8");
    return JSON.parse(raw) as ScopeRecord;
  } catch {
    return null;
  }
}

/**
 * Writes a scope record.
 */
export async function writeScope(record: ScopeRecord): Promise<void> {
  await mkdir(join(registryRoot(), SCOPES_DIR), { recursive: true });
  await writeFile(
    recordPath(record.scopeId),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Records that a sandbox of this scope is alive.
 *
 * @remarks
 * The heartbeat is what keeps a scope from being swept while it is working.
 * It is a touch of a small file, not a lock: two sandboxes of the same scope
 * may write at the same time, and the last writer wins.
 */
export async function heartbeat(
  scopeId: string,
  sandboxId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await readScope(scopeId);
  const sandboxes = new Set(existing?.sandboxes ?? []);
  sandboxes.add(sandboxId);
  await writeScope({
    scopeId,
    status: existing?.status ?? "running",
    createdAt: existing?.createdAt ?? now,
    lastHeartbeatAt: now,
    sandboxes: [...sandboxes],
  });
}

/**
 * Moves a scope to a terminal status.
 *
 * @remarks
 * Called when the root session ends: no more sandboxes will open for that
 * scope, so its checkout is garbage and the janitor can take it.
 */
export async function markScopeTerminal(
  scopeId: string,
  status: ScopeStatus = "completed",
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await readScope(scopeId);
  await writeScope({
    scopeId,
    status,
    createdAt: existing?.createdAt ?? now,
    lastHeartbeatAt: now,
    sandboxes: existing?.sandboxes ?? [],
  });
}

/**
 * Forgets a scope.
 *
 * @remarks
 * Called by the janitor once the scope's resources are gone. Without it the
 * registry would grow one file per task forever.
 */
export async function forgetScope(scopeId: string): Promise<void> {
  await rm(recordPath(scopeId), { force: true });
}

/**
 * Every scope the registry knows about.
 *
 * @remarks
 * A file that does not parse is skipped: a corrupted registry must not stop
 * the janitor from cleaning the rest.
 */
export async function listScopes(): Promise<ScopeRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(join(registryRoot(), SCOPES_DIR));
  } catch {
    return [];
  }
  const records: ScopeRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const record = await readScope(entry.replace(/\.json$/, ""));
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}
