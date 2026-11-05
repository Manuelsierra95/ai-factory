import type { DockerSandboxSession } from "eve/sandbox/docker";
import { DockerSandbox } from "eve/sandbox/docker";
import { requireFactoryRepo } from "../constants.js";
import {
  appAccessMessage,
  describeCloneFailure,
  safeErrorMessage,
  sanitizeCommandOutput,
} from "./bootstrap-diagnostics.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "./bot-name.js";
import { resolveGitHubToken } from "./credentials.js";
import { gitAuthEnv, remoteUrl } from "./git-remote.js";

/**
 * Image every station sandbox runs.
 *
 * @remarks
 * eve's published image is the default, and `FACTORY_SANDBOX_IMAGE` overrides
 * it. The plan's own image (Playwright browsers included, no passwordless
 * sudo) is the target; until it exists, the default keeps the factory
 * runnable.
 */
export const FACTORY_SANDBOX_IMAGE =
  process.env.FACTORY_SANDBOX_IMAGE ?? undefined;

/**
 * Creates a station's Docker environment.
 *
 * @remarks
 * Each station calls this from its own `sandbox.ts`, so the environment's
 * generation is keyed to that file. Docker has no snapshot: every session
 * starts a container from the base image, which is why the shared checkout
 * lives in a volume instead of in the image.
 */
export function createFactoryEnvironment() {
  return DockerSandbox.environment({
    ...(FACTORY_SANDBOX_IMAGE ? { image: FACTORY_SANDBOX_IMAGE } : {}),
    pullPolicy: "if-not-present",
  });
}

/**
 * Runs a command in the sandbox and throws on a nonzero exit, so a broken
 * clone or setup fails the session loudly instead of leaving a half-checked-
 * out repository behind.
 */
async function runOrThrow(
  sandbox: DockerSandboxSession,
  command: string,
  env?: Record<string, string>,
): Promise<void> {
  const result = await sandbox.run({ command, ...(env ? { env } : {}) });
  if (result.exitCode !== 0) {
    throw new Error(
      sanitizeCommandOutput(
        `Sandbox command failed (exit ${result.exitCode}): ${command}\n${String(
          result.stderr || result.stdout,
        ).trim()}`,
      ),
    );
  }
}

/**
 * Characters allowed in a bot name interpolated into a shell-quoted git
 * config command.
 */
const SAFE_BOT_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The bot's commit identity.
 */
async function gitIdentity(): Promise<{ email: string; name: string }> {
  const resolved = await resolveBotName().catch(() => FALLBACK_BOT_NAME);
  const safe = SAFE_BOT_NAME.test(resolved) ? resolved : FALLBACK_BOT_NAME;
  return {
    email: `${safe.toLowerCase()}[bot]@users.noreply.github.com`,
    name: `${safe}[bot]`,
  };
}

/**
 * Session-scoped setup shared by the station sandboxes: fix git's ownership
 * check, set the bot's commit identity, and clone the factory repository.
 *
 * @remarks
 * The credential travels as a per-command environment variable, scoped to
 * `github.com` by git's own config, so it never appears in the command line
 * and never reaches another host. It is not baked into the image.
 *
 * The template snapshot is owned by the builder uid, not the session user;
 * without the `safe.directory` entries every git command dies on "dubious
 * ownership".
 */
export async function factoryInit(
  sandbox: DockerSandboxSession,
): Promise<void> {
  const identity = await gitIdentity();
  await runOrThrow(
    sandbox,
    `git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo && git config --global user.name "${identity.name}" && git config --global user.email "${identity.email}"`,
  );
  const token = await resolveGitHubToken().catch((error: unknown) => {
    throw new Error(appAccessMessage(requireFactoryRepo()), { cause: error });
  });
  try {
    await runOrThrow(
      sandbox,
      `git clone --depth 50 ${remoteUrl()} repo`,
      gitAuthEnv(token),
    );
  } catch (error) {
    throw new Error(
      describeCloneFailure(requireFactoryRepo(), safeErrorMessage(error)),
      { cause: error },
    );
  }
  const setup = process.env.FACTORY_SETUP_COMMAND;
  if (setup) {
    await runOrThrow(sandbox, `cd repo && ${setup}`);
  }
}
