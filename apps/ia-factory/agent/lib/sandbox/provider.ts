import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { once } from "node:events";
import {
  defineSandboxProvider,
  SandboxSessionGoneError,
  type SandboxConnection,
  type SandboxProviderImplementation,
} from "eve/sandbox/provider";
import { docker, dockerOrThrow, dockerProcess } from "./docker-cli.js";
import {
  labelArgs,
  MANAGED_LABEL,
  ROLE_LABEL,
  SANDBOX_LABEL,
  SCOPE_LABEL,
  SESSION_LABEL,
  CREATED_AT_LABEL,
  VOLUME_LABEL,
  sandboxIdFor,
  sandboxLabels,
  volumeLabels,
  volumeNameFor,
} from "./labels.js";
import { heartbeat, markScopeTerminal, readScope } from "./registry.js";
import { sweep } from "./janitor.js";
import { removeContainer, removeVolume } from "./janitor.js";

/**
 * The factory's Docker sandbox provider.
 *
 * @remarks
 * A local container per station session, with the factory's own labels, a
 * shared volume per task, and a lifecycle that leaves nothing behind.
 *
 * Three properties matter more than the rest:
 *
 * 1. **The container name comes from the session id alone.** Two callers
 *    that open the same session reach the same container, even across
 *    processes.
 * 2. **The credential never reaches the container.** The git token travels
 *    as the environment of the single command that needs it.
 * 3. **Every resource is labelled and swept.** The janitor only removes
 *    resources carrying `ia-factory.managed=true`, and only when their task
 *    is over.
 */

/** Where commands start and relative paths resolve. */
const WORKSPACE_ROOT = "/workspace";

/** Where the shared checkout is mounted. */
const REPO_DIR = "/workspace/repo";

/**
 * The image eve publishes, pinned by digest.
 *
 * @remarks
 * Pinned because the tag moves: the same tag served a root user in one
 * moment and a non-root user in the next, and a sandbox that works on one
 * machine fails on another. The digest is the contract.
 */
const DEFAULT_IMAGE =
  "ghcr.io/vercel/eve@sha256:35014dfac4d298d471b523878a6cf3bf171be42a2caaf8de7aa31eb7001f1145";

/** Keeps the container alive between commands. */
const KEEPALIVE = ["-c", "sleep 2147483647"];

export interface IaFactorySandboxOptions {
  /** The role this sandbox plays, recorded as a label. */
  readonly role?: string;
  /** The base image. */
  readonly image?: string;
  /**
   * Whether the shared checkout is writable here. Only the builder writes.
   */
  readonly volumeMode?: "ro" | "rw";
}

/**
 * The scope a sandbox belongs to.
 *
 * @remarks
 * The scope is the root of the dispatch chain: the session the developer
 * talks to. Every station of a task is a descendant of it, and eve populates
 * `parent.rootSessionId` at dispatch, so all the stations of a task resolve
 * to the same scope without passing anything around.
 *
 * That is what makes the shared checkout work. The alternatives are worse:
 * an environment variable is process-global and two tasks running at the
 * same time would fight over it, and a task id in the message would have to
 * be threaded through every station by hand.
 */
function scopeFor(ctx: { session: { id: string; parent?: { rootSessionId: string } } }): string {
  return ctx.session.parent?.rootSessionId ?? ctx.session.id;
}

/**
 * Whether a container exists.
 */
async function containerExists(name: string): Promise<boolean> {
  const result = await docker([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}",
    name,
  ]);
  return result.exitCode === 0;
}

/**
 * Whether a container is running.
 */
async function containerRunning(name: string): Promise<boolean> {
  const result = await docker([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}",
    name,
  ]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/**
 * Whether an image exists locally.
 */
async function imageExists(reference: string): Promise<boolean> {
  const result = await docker(["image", "inspect", reference]);
  return result.exitCode === 0;
}

/**
 * Creates the shared volume of a task, if it does not exist yet.
 *
 * @remarks
 * A named volume is born owned by root, and the sandbox runs as the image's
 * user (`vercel-sandbox`, not root). Without this the sandbox can read the
 * checkout and cannot write to it, which looks exactly like a permissions
 * bug and is not one.
 *
 * The ownership is aligned with the image's own `/workspace`, so the
 * sandbox writes as the same user that owns the workspace everywhere else.
 */
async function ensureVolume(
  volumeName: string,
  scope: string,
  image: string,
): Promise<void> {
  const exists = await docker(["volume", "inspect", volumeName]);
  if (exists.exitCode !== 0) {
    await dockerOrThrow(
      [
        "volume",
        "create",
        ...labelArgs(volumeLabels({ scope, createdAt: new Date().toISOString() })),
        volumeName,
      ],
      `create volume "${volumeName}"`,
    );
  }

  // A one-shot root container aligns the volume's ownership with the image's
  // workspace. It runs once, at creation, and never touches the contents.
  await docker([
    "run",
    "--rm",
    "--user",
    "root",
    "-v",
    `${volumeName}:${REPO_DIR}`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    `chown --reference=/workspace ${REPO_DIR} 2>/dev/null || true`,
  ]);
}

/**
 * Collects a Docker process's stderr while it runs.
 *
 * @remarks
 * The error messages of the provider are only useful if they carry what the
 * container said: "no such file", "read-only file system" and "permission
 * denied" are the difference between a bug and a policy. The listener has to
 * be attached before the process closes, or the output is gone.
 */
function collectStderr(child: ChildProcess): { text(): string } {
  const chunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

/**
 * The byte-level connection to one container.
 */
function connect(containerName: string): SandboxConnection {
  return {
    workspaceRoot: WORKSPACE_ROOT,

    async spawn({ command, env, workingDirectory, signal, stdin }) {
      const token = randomUUID().slice(0, 8);

      // The command travels in an environment variable, never in the
      // argument list, so no quoting rule can change its meaning. The
      // wrapper gives the in-container process a recognisable argv[0], which
      // is what `kill` targets.
      const args = ["exec"];
      if (stdin !== false) {
        args.push("-i");
      }
      args.push("-e", `IAF_COMMAND=${command}`, "-e", `IAF_EXEC_TOKEN=${token}`);
      for (const [key, value] of Object.entries(env)) {
        args.push("-e", `${key}=${value}`);
      }
      args.push(
        "-w",
        workingDirectory || WORKSPACE_ROOT,
        containerName,
        "bash",
        "-lc",
        'exec -a "iaf-exec-$IAF_EXEC_TOKEN" bash -lc "$IAF_COMMAND"',
      );

      const child = dockerProcess(args, { stdin: stdin !== false });
      const stdout = Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>;
      const stderr = Readable.toWeb(child.stderr as Readable) as ReadableStream<Uint8Array>;

      const kill = async (): Promise<void> => {
        // Kill the process inside the container first: killing the client
        // alone would leave it running.
        await docker([
          "exec",
          containerName,
          "pkill",
          "-f",
          `iaf-exec-${token}`,
        ]).catch(() => undefined);
        child.kill("SIGKILL");
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", () => {
          void kill();
        });
      }

      return {
        stdout,
        stderr,
        wait: async () => {
          const [code] = (await once(child, "close")) as [number | null];
          return { exitCode: code ?? 1 };
        },
        kill,
      };
    },

    async readFile({ path, signal }) {
      const child = dockerProcess([
        "exec",
        containerName,
        "bash",
        "-lc",
        `if [ -f '${path}' ]; then cat '${path}'; else exit 3; fi`,
      ]);
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      const stderr = collectStderr(child);
      if (signal !== undefined) {
        signal.addEventListener("abort", () => child.kill("SIGKILL"));
      }
      const [code] = (await once(child, "close")) as [number | null];
      if (code === 3) {
        return null;
      }
      if (code !== 0) {
        throw new Error(
          `Cannot read ${path} from the sandbox (exit ${code}): ${stderr.text().trim() || "no output"}`,
        );
      }
      return new Uint8Array(Buffer.concat(chunks));
    },

    async writeFiles({ files, signal }) {
      for (const file of files) {
        const child = dockerProcess([
          "exec",
          "-i",
          containerName,
          "bash",
          "-lc",
          `mkdir -p "$(dirname '${file.path}')" && base64 -d > '${file.path}'`,
        ]);
        if (signal !== undefined) {
          signal.addEventListener("abort", () => child.kill("SIGKILL"));
        }
        const stderr = collectStderr(child);
        child.stdin?.end(Buffer.from(file.content).toString("base64"));
        const [code] = (await once(child, "close")) as [number | null];
        if (code !== 0) {
          throw new Error(
            `Cannot write ${file.path} in the sandbox (exit ${code}): ${stderr.text().trim() || "no output"}`,
          );
        }
      }
    },

    async removePath({ path }) {
      await docker(["exec", containerName, "bash", "-lc", `rm -rf '${path}'`]);
    },

    async stop() {
      await docker(["stop", "-t", "0", containerName]);
    },
  };
}

/**
 * The template the containers start from.
 *
 * @remarks
 * eve serialises the artifact and the state as JSON, so both carry an index
 * signature.
 */
interface IaFactoryArtifact {
  readonly [key: string]: string | number;
  readonly imageReference: string;
  readonly version: number;
}

/**
 * The minimum a later step needs to find this sandbox again.
 */
interface IaFactoryState {
  readonly [key: string]: string | number;
  readonly containerName: string;
  readonly volumeName: string;
  readonly scope: string;
  readonly version: number;
}

/**
 * The provider definition.
 */
/**
 * Starts the janitor, once per app process.
 *
 * @remarks
 * The interval starts on the first sandbox, never at build time: `eve build`
 * imports this module, and a timer there would hang the build. `unref` keeps
 * it from holding the process open.
 */
let janitorStarted = false;
function ensureJanitor(): void {
  if (janitorStarted) {
    return;
  }
  janitorStarted = true;
  const ttlMinutes = Number(process.env.FACTORY_SANDBOX_TTL_MINUTES ?? 120);
  const intervalMs = Math.max(ttlMinutes, 5) * 60_000;
  const timer = setInterval(() => {
    void sweep({ ttlMinutes }).catch(() => undefined);
  }, intervalMs);
  timer.unref();
}

/**
 * The lifecycle one factory sandbox environment implements.
 *
 * @remarks
 * Exported on its own so the tests can drive it without eve's runtime:
 * `environment()` only exposes `open()`, and the plumbing that matters
 * (labels, volumes, streams, cleanup) lives here.
 */
export function createIaFactoryImplementation(
  options: IaFactorySandboxOptions,
): SandboxProviderImplementation<
  { readonly networkPolicy?: "allow-all" | "deny-all" },
  IaFactoryArtifact,
  IaFactoryState,
  {}
> {
  const role = options.role ?? "station";
  const image = options.image ?? DEFAULT_IMAGE;
  const volumeMode = options.volumeMode ?? "ro";

  return {
      async prepare(ctx) {
        const key = ctx.templateKey({ image, role, volumeMode }).slice(0, 24);
        const imageReference = `iaf-tpl-${key}`;

        if (await imageExists(imageReference)) {
          ctx.log(`reusing sandbox template "${imageReference}"`);
          return { imageReference, version: 1 };
        }

        const buildName = `${imageReference}-build`;
        await dockerOrThrow(
          [
            "run",
            "-d",
            "--name",
            buildName,
            ...labelArgs({
              [MANAGED_LABEL]: "true",
              [ROLE_LABEL]: "template-build",
              [CREATED_AT_LABEL]: new Date().toISOString(),
            }),
            "--workdir",
            WORKSPACE_ROOT,
            "--entrypoint",
            "/bin/sh",
            image,
            ...KEEPALIVE,
          ],
          `start template build container "${buildName}"`,
        );

        try {
          // Seeds the workspace and the skill files, then runs the authored
          // prepare over the same container.
          await ctx.populate(connect(buildName));
          await dockerOrThrow(
            ["commit", buildName, imageReference],
            `commit sandbox template "${imageReference}"`,
          );
        } finally {
          await docker(["rm", "-f", buildName]);
        }

        return { imageReference, version: 1 };
      },

      async start(ctx, open, artifact) {
        ensureJanitor();
        const sessionId = ctx.session.id;
        const containerName = sandboxIdFor(sessionId);
        const scope = scopeFor(ctx);
        const volumeName = volumeNameFor(scope);
        const createdAt = new Date().toISOString();

        await ensureVolume(volumeName, scope, artifact.imageReference);

        if (!(await containerExists(containerName))) {
          const created = await docker([
            "run",
            "-d",
            "--name",
            containerName,
              ...labelArgs(
                sandboxLabels({
                  sandboxId: containerName,
                  sessionId,
                  scope,
                  role,
                  createdAt,
                  volume: volumeName,
                }),
              ),
              "-v",
              `${volumeName}:${REPO_DIR}:${volumeMode === "rw" ? "rw" : "ro"}`,
              ...(open?.networkPolicy === "deny-all"
                ? ["--network", "none"]
                : []),
              "--workdir",
              WORKSPACE_ROOT,
              "--entrypoint",
              "/bin/sh",
            artifact.imageReference,
            ...KEEPALIVE,
          ]);

          if (created.exitCode !== 0) {
            // Another process created the same container between the check
            // and the run. The container is the one we wanted, so the
            // conflict is a success, not an error.
            if (!/is already in use/iu.test(created.stderr)) {
              throw new Error(
                `Docker start sandbox container "${containerName}" failed (exit ${created.exitCode}): ${created.stderr.trim()}`,
              );
            }
          }
        } else if (!(await containerRunning(containerName))) {
          await docker(["start", containerName]);
        }

        await heartbeat(scope, containerName);

        return {
          connection: connect(containerName),
          state: { containerName, volumeName, scope, version: 1 },
        };
      },

      async resume(_ctx, _artifact, state) {
        if (!(await containerExists(state.containerName))) {
          throw new SandboxSessionGoneError(
            `Sandbox container "${state.containerName}" no longer exists.`,
          );
        }
        if (!(await containerRunning(state.containerName))) {
          await docker(["start", state.containerName]);
        }
        await heartbeat(state.scope, state.containerName);
        return connect(state.containerName);
      },

    async onSessionEnd(ctx, state, { signal }) {
        const containerName = state?.containerName ?? sandboxIdFor(ctx.session.id);
        const removed = await docker(["rm", "-f", containerName], { signal });
        if (removed.exitCode !== 0 && !/no such container/iu.test(removed.stderr)) {
          throw new Error(
            `Cannot remove sandbox container "${containerName}": ${removed.stderr.trim()}`,
          );
        }

        // The root session is the task: when it ends, the scope is over and
        // nothing else will open a sandbox for it.
        const scope = state?.scope ?? scopeFor(ctx);
        if (ctx.session.parent === undefined) {
          await markScopeTerminal(scope);
        }

        // The volume belongs to the scope, not to the session: it survives
        // while the scope works and goes when the scope is over.
        const record = await readScope(scope);
        if (
          record !== null &&
          record.status !== "running" &&
          record.status !== "iterating"
        ) {
          await removeVolume(state?.volumeName ?? volumeNameFor(scope));
        }
    },
  };
}

/**
 * The provider definition.
 */
export const IaFactorySandbox = defineSandboxProvider<
  IaFactorySandboxOptions,
  { readonly networkPolicy?: "allow-all" | "deny-all" },
  IaFactoryArtifact,
  IaFactoryState,
  {}
>({
  name: "ia-factory-docker",
  stateProtocolVersion: 1,
  environment: (options) => createIaFactoryImplementation(options),
});

export {
  MANAGED_LABEL,
  SANDBOX_LABEL,
  SCOPE_LABEL,
  SESSION_LABEL,
  VOLUME_LABEL,
  removeContainer,
};
