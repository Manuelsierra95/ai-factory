import { randomUUID } from "node:crypto";
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
  SESSION_LABEL,
  TASK_LABEL,
  CREATED_AT_LABEL,
  VOLUME_LABEL,
  sandboxIdFor,
  sandboxLabels,
  volumeLabels,
  volumeNameFor,
} from "./labels.js";
import { heartbeat, readTask } from "./registry.js";
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

/** The image eve publishes, used when nothing else is configured. */
const DEFAULT_IMAGE = "ghcr.io/vercel/eve:latest";

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
  /** Task id override, for tests. */
  readonly taskId?: string;
}

/**
 * The task a sandbox belongs to.
 *
 * @remarks
 * The pipeline sets `FACTORY_TASK_ID` for every station of a task, which is
 * what makes them share one checkout. Without it, a sandbox gets its own
 * volume, which is the safe default: two unrelated tasks never share a
 * working directory.
 */
function taskIdFor(sessionId: string, override?: string): string {
  return override ?? process.env.FACTORY_TASK_ID ?? `session-${sessionId}`;
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
 */
async function ensureVolume(
  volumeName: string,
  taskId: string,
): Promise<void> {
  const exists = await docker(["volume", "inspect", volumeName]);
  if (exists.exitCode === 0) {
    return;
  }
  await dockerOrThrow(
    [
      "volume",
      "create",
      ...labelArgs(volumeLabels({ taskId, createdAt: new Date().toISOString() })),
      volumeName,
    ],
    `create volume "${volumeName}"`,
  );
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
      if (signal !== undefined) {
        signal.addEventListener("abort", () => child.kill("SIGKILL"));
      }
      const [code] = (await once(child, "close")) as [number | null];
      if (code === 3) {
        return null;
      }
      if (code !== 0) {
        throw new Error(`Cannot read ${path} from the sandbox.`);
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
        child.stdin?.end(Buffer.from(file.content).toString("base64"));
        const [code] = (await once(child, "close")) as [number | null];
        if (code !== 0) {
          throw new Error(`Cannot write ${file.path} in the sandbox.`);
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
  readonly taskId: string;
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
        const taskId = taskIdFor(sessionId, options.taskId);
        const volumeName = volumeNameFor(taskId);
        const createdAt = new Date().toISOString();

        await ensureVolume(volumeName, taskId);

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
                  taskId,
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

        await heartbeat(taskId, containerName);

        return {
          connection: connect(containerName),
          state: { containerName, volumeName, taskId, version: 1 },
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
        await heartbeat(state.taskId, state.containerName);
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

        // The volume belongs to the task, not to the session: it survives
        // while the task works and goes when the task is over.
        const taskId = state?.taskId ?? taskIdFor(ctx.session.id, options.taskId);
        const record = await readTask(taskId);
      if (record !== null && record.status !== "running" && record.status !== "iterating") {
        await removeVolume(state?.volumeName ?? volumeNameFor(taskId));
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

export { MANAGED_LABEL, SANDBOX_LABEL, SESSION_LABEL, TASK_LABEL, VOLUME_LABEL, removeContainer };
