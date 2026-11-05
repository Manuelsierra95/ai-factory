import { requireFactoryRepo } from "../constants.js";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * Conservative subset of valid git branch names: alphanumeric segments
 * separated by `.`, `_`, `-` or `/`. Everything the git commands interpolate
 * has to match this, so shell metacharacters can never reach the command
 * line.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Where the station sandboxes keep the factory repository checkout.
 */
export const REPO_DIR = "/workspace/repo";

/**
 * The URL every clone, fetch, and push targets, literally.
 *
 * @remarks
 * Git remote config inside a sandbox (`pushurl`, `pushDefault`, per-branch
 * remotes) is model-writable and must not be able to redirect the brokered
 * credential, so the git helpers never go through `origin`.
 *
 * Resolved per call: the repository comes from the environment, and a
 * missing value has to fail at the git operation, not at module load.
 */
export function remoteUrl(): string {
  return `https://github.com/${requireFactoryRepo()}.git`;
}

/**
 * Returns the refusal reason, or null when the branch name may be used in a
 * git command.
 *
 * @remarks
 * `refs/heads/main` and `HEAD` would reach a protected branch under another
 * name, so only plain branch names are accepted, and the protected branches
 * themselves are refused outright: the factory delivers pull requests, never
 * direct pushes to the default branch.
 */
export function validateBranch(branch: string): string | null {
  if (
    !BRANCH_PATTERN.test(branch) ||
    branch.includes("..") ||
    branch.includes("//")
  ) {
    return `"${branch}" is not a valid branch name.`;
  }
  if (branch.startsWith("refs/") || branch === "HEAD") {
    return `"${branch}" is not a plain branch name. Pass the branch name without a refs/ prefix.`;
  }
  if (PROTECTED_BRANCHES.has(branch)) {
    return `Direct pushes to ${branch} are not allowed. Push a feature branch and open a pull request.`;
  }
  return null;
}

/**
 * Per-command environment that authenticates git against github.com.
 *
 * @remarks
 * The token never appears in the command line and never reaches another
 * host: git's own config scopes the header to `https://github.com/`, and the
 * value lives in the environment of the single command that needs it. It is
 * not baked into the sandbox image.
 *
 * This is the Docker counterpart of the hosted provider's firewall transform:
 * both keep the credential out of the sandbox's long-lived state.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const authorization = `Basic ${Buffer.from(
    `x-access-token:${token}`,
  ).toString("base64")}`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
}
