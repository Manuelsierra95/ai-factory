import { createHash } from "node:crypto";

/**
 * Names and labels for the factory's Docker resources.
 *
 * @remarks
 * Every resource the factory creates carries `ia-factory.managed=true`. The
 * janitor only ever touches resources with that label, so it can never
 * remove a container or a volume that belongs to somebody else on the same
 * machine.
 */

/** The label that marks a resource as ours. */
export const MANAGED_LABEL = "ia-factory.managed";

/**
 * The label that carries the scope a resource belongs to.
 *
 * @remarks
 * The scope is the root of a dispatch chain, which is what the sandbox
 * layer can know on its own. The factory's own task id arrives later, as an
 * extra label, when the pipeline writes it.
 */
export const SCOPE_LABEL = "ia-factory.scope-id";

/** The label that carries the sandbox id. */
export const SANDBOX_LABEL = "ia-factory.sandbox-id";

/** The label that carries the session id. */
export const SESSION_LABEL = "ia-factory.session-id";

/** The label that carries the role a sandbox plays. */
export const ROLE_LABEL = "ia-factory.role";

/** The label that carries the creation timestamp. */
export const CREATED_AT_LABEL = "ia-factory.created-at";

/** The label that carries the shared volume a sandbox mounts. */
export const VOLUME_LABEL = "ia-factory.volume";

/**
 * A short, stable id derived from a session id.
 *
 * @remarks
 * The container name comes from the session id alone, never from the open
 * options or the artifact: two callers that open the same session must
 * reach the same container.
 */
export function sandboxIdFor(sessionId: string): string {
  return `iaf-sbx-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

/**
 * The shared volume name for a scope.
 *
 * @remarks
 * Every station of a scope mounts the same volume, so the checkout happens
 * once. The name comes from the scope id, which every station of the same
 * task resolves to on its own.
 */
export function volumeNameFor(scope: string): string {
  return `iaf-vol-${createHash("sha256").update(scope).digest("hex").slice(0, 20)}`;
}

/**
 * The labels every factory container carries.
 */
export function sandboxLabels(input: {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly role: string;
  readonly createdAt: string;
  readonly volume?: string;
}): Record<string, string> {
  return {
    [MANAGED_LABEL]: "true",
    [SANDBOX_LABEL]: input.sandboxId,
    [SESSION_LABEL]: input.sessionId,
    [SCOPE_LABEL]: input.scope,
    [ROLE_LABEL]: input.role,
    [CREATED_AT_LABEL]: input.createdAt,
    ...(input.volume ? { [VOLUME_LABEL]: input.volume } : {}),
  };
}

/**
 * The labels a factory volume carries.
 */
export function volumeLabels(input: {
  readonly scope: string;
  readonly createdAt: string;
}): Record<string, string> {
  return {
    [MANAGED_LABEL]: "true",
    [SCOPE_LABEL]: input.scope,
    [CREATED_AT_LABEL]: input.createdAt,
  };
}

/**
 * Renders labels as `--label` arguments.
 */
export function labelArgs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
}
