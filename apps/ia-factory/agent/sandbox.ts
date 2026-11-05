import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { FACTORY_SANDBOX_IMAGE } from "./lib/github/repo-sandbox.js";

/**
 * Root agent sandbox configuration.
 *
 * @remarks
 * Local Docker containers, in development and in production alike, so the
 * factory never depends on a hosted sandbox service. `FACTORY_SANDBOX_IMAGE`
 * pins the image; without it, eve's published image is used.
 *
 * The post-open init marks `/workspace` as a safe git directory. The
 * container filesystem is owned by the builder uid, not the session user, so
 * without this git aborts every command with "detected dubious ownership in
 * repository at '/workspace'". The station sandboxes handle the same hazard
 * for `/workspace/repo` in `agent/lib/github/repo-sandbox.ts`.
 */
export const environment = DockerSandbox.environment({
  ...(FACTORY_SANDBOX_IMAGE ? { image: FACTORY_SANDBOX_IMAGE } : {}),
  pullPolicy: "if-not-present",
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  const result = await sandbox.run({
    command: "git config --global --add safe.directory /workspace",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to mark /workspace as a safe git directory (exit ${result.exitCode}): ${String(
        result.stderr || result.stdout,
      ).trim()}`,
    );
  }
  return sandbox;
});
