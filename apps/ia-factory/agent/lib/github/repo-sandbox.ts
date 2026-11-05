import type { SandboxSession } from "eve/sandbox";
import { IaFactorySandbox } from "../sandbox/provider.js";
import {
  appAccessMessage,
  describeCloneFailure,
  safeErrorMessage,
  sanitizeCommandOutput,
} from "../github/bootstrap-diagnostics.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "../github/bot-name.js";
import { resolveGitHubToken } from "../github/credentials.js";
import { gitAuthEnv, remoteUrl } from "../github/git-remote.js";

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
 * Creates a station's sandbox environment.
 *
 * @remarks
 * Every station of a task mounts the same volume at `/workspace/repo`, so
 * the checkout happens once and the install happens once. Only the builder
 * mounts it writable; the others see it read-only, which is what keeps a
 * reviewer from editing the diff it is judging.
 */
export function createFactoryEnvironment(role: "builder" | "analyser" | "station" = "station") {
  return IaFactorySandbox.environment({
    role,
    ...(FACTORY_SANDBOX_IMAGE ? { image: FACTORY_SANDBOX_IMAGE } : {}),
    volumeMode: role === "builder" ? "rw" : "ro",
  });
}

/**
 * Runs a command in the sandbox and throws on a nonzero exit, so a broken
 * clone or setup fails the session loudly instead of leaving a half-checked-
 * out repository behind.
 */
async function runOrThrow(
  sandbox: SandboxSession,
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
 * check and set the bot's commit identity.
 *
 * @remarks
 * The clone itself is the builder's job, not every station's: the builder
 * populates the shared volume, and the other stations read it. That is what
 * makes one clone and one install per task the rule instead of the
 * exception.
 *
 * The credential travels as a per-command environment variable, scoped to
 * `github.com` by git's own config, so it never appears in the command line
 * and never reaches another host.
 */
export async function factoryInit(
  sandbox: SandboxSession,
): Promise<void> {
  const identity = await gitIdentity();
  await runOrThrow(
    sandbox,
    `git config --global --add safe.directory /workspace && git config --global --add safe.directory /workspace/repo && git config --global user.name "${identity.name}" && git config --global user.email "${identity.email}"`,
  );
}

/**
 * Clones the factory repository into the shared volume and runs the setup
 * command.
 *
 * @remarks
 * Only the builder calls this. The token is resolved once, here, and handed
 * to git as the environment of the clone command.
 */
export async function factoryClone(
  sandbox: SandboxSession,
): Promise<void> {
  const token = await resolveGitHubToken().catch((error: unknown) => {
    throw new Error(appAccessMessage("the configured repository"), { cause: error });
  });
  try {
    await runOrThrow(
      sandbox,
      `git clone --depth 50 ${remoteUrl()} repo`,
      gitAuthEnv(token),
    );
  } catch (error) {
    throw new Error(
      describeCloneFailure("the configured repository", safeErrorMessage(error)),
      { cause: error },
    );
  }
  const setup = process.env.FACTORY_SETUP_COMMAND;
  if (setup) {
    await runOrThrow(sandbox, `cd repo && ${setup}`);
  }
}
