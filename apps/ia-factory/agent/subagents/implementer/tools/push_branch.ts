import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveGitHubToken } from "../../../lib/github/credentials.js";
import {
  gitAuthEnv,
  remoteUrl,
  REPO_DIR,
  validateBranch,
} from "../../../lib/github/git-remote.js";
import { environment } from "../sandbox.js";

/**
 * Pushes a committed feature branch of the sandbox checkout to the factory
 * repository.
 *
 * @remarks
 * The push is inert by construction, which is why it runs without approval:
 * `validateBranch` refuses `main`, `master`, and anything that isn't a plain
 * branch name, so nothing this tool does can change the default branch or
 * merge.
 *
 * The credential travels as the environment of the two commands that need it,
 * scoped to `github.com` by git's own config. It is not in the command line,
 * not in the image, and not in the sandbox's long-lived state. The push
 * targets {@link remoteUrl} literally, never the model-writable `origin`
 * remote.
 */
export default defineTool({
  description: `Push a local branch of the ${REPO_DIR} checkout to the factory repository. The branch must already exist locally with the work committed and the checks run; main and master are refused. After a successful push, report the branch name in your structured output so the orchestrator can open the pull request.`,
  async execute(input, ctx) {
    const refusal = validateBranch(input.branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    const sandbox = await ctx.getSandbox(environment);
    const authEnv = gitAuthEnv(await resolveGitHubToken());

    const push = await sandbox.run({
      env: authEnv,
      command: `git -C ${REPO_DIR} push ${remoteUrl()} 'refs/heads/${input.branch}:refs/heads/${input.branch}'`,
    });
    if (push.exitCode !== 0) {
      return {
        error: `git push exited ${push.exitCode}: ${String(
          push.stderr || push.stdout,
        ).trim()}`,
        success: false as const,
      };
    }

    const head = await sandbox.run({
      env: authEnv,
      command: `git -C ${REPO_DIR} rev-parse '${input.branch}'`,
    });
    return {
      branch: input.branch,
      sha: String(head.stdout).trim(),
      success: true as const,
    };
  },
  inputSchema: z.object({
    branch: z
      .string()
      .min(1)
      .describe(
        "Branch name in /workspace/repo to push, e.g. factory/bug-dedupe-reset-emails",
      ),
  }),
});
