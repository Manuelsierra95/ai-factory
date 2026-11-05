import { spawn, type ChildProcess } from "node:child_process";

/**
 * A thin wrapper over the `docker` CLI.
 *
 * @remarks
 * The factory talks to Docker through the CLI on purpose: the daemon is
 * local, the CLI is the stable interface, and every command here is a plain
 * argument list, never a shell string. Nothing in this module builds a
 * command line out of model input.
 */
export interface DockerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a Docker command and collects its output.
 *
 * @remarks
 * The output is text. For binary payloads the callers pipe bytes through
 * stdin instead of through the command line.
 */
export async function docker(
  args: readonly string[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<DockerResult> {
  const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const aborted = new Promise<never>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      child.kill("SIGKILL");
      reject(new Error("Docker command aborted."));
    });
  });

  const finished = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  const exitCode = await Promise.race([finished, aborted]);
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

/**
 * Runs a Docker command and throws unless it succeeds.
 *
 * @remarks
 * The message names the operation, not the whole argument list: the
 * arguments can carry a repository URL or a branch name.
 */
export async function dockerOrThrow(
  args: readonly string[],
  operation: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DockerResult> {
  const result = await docker(args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Docker ${operation} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

/**
 * Starts a Docker command without waiting for it, for the streaming case.
 *
 * @remarks
 * The caller owns the process: it wires the streams and waits for it.
 */
export function dockerProcess(
  args: readonly string[],
  options: { readonly stdin?: boolean } = {},
): ChildProcess {
  return spawn("docker", [...args], {
    stdio: [
      options.stdin === false ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ],
  });
}

/**
 * Whether the Docker daemon answers.
 *
 * @remarks
 * The factory's preflight uses this to fail with an actionable message
 * instead of letting the first task die inside a sandbox.
 */
export async function isDockerAvailable(): Promise<boolean> {
  const result = await docker(["info", "--format", "{{.ServerVersion}}"]);
  return result.exitCode === 0;
}
