/**
 * Reads a required environment variable, throwing if it is unset so
 * misconfiguration fails fast instead of surfacing mid-request.
 *
 * @param name - The environment variable name.
 * @param example - An example value, included in the error message.
 * @returns The environment variable's value.
 */
export function requireEnv(name: string, example: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is not set (e.g. '${example}').`,
    );
  }
  return value;
}

// GitHub's own naming rules: owner is alphanumeric with inner hyphens, repo
// adds dots and underscores. Catching a malformed value here fails the git
// operation with a clear message instead of a cryptic clone error.
const FACTORY_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/**
 * The repository the factory works on, as `owner/repo`.
 *
 * @remarks
 * Read lazily, not at module load: the app is one package in a monorepo, and
 * a missing value must not stop `eve build` or `eve info` on a machine that
 * is not going to run a task today. The git operations that need it call
 * {@link requireFactoryRepo} and get an actionable error.
 */
export function requireFactoryRepo(): string {
  const repo = process.env.FACTORY_REPO;
  if (!repo) {
    throw new Error(
      "FACTORY_REPO environment variable is not set (e.g. 'owner/repo').",
    );
  }
  if (!FACTORY_REPO_PATTERN.test(repo)) {
    throw new Error(
      `FACTORY_REPO must reference an existing GitHub repository in owner/repo format (e.g. 'owner/repo'), got '${repo}'.`,
    );
  }
  return repo;
}

/**
 * The branch-name prefix for the factory's own feature branches.
 *
 * @remarks
 * The implementer names its branches `factory/<type>-<slug>`.
 */
export const FACTORY_BRANCH_PREFIX =
  process.env.FACTORY_BRANCH_PREFIX ?? "factory/";
