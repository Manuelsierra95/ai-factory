import { defineSandbox } from "eve/sandbox";
import { IaFactorySandbox } from "./lib/sandbox/provider.js";

/**
 * Root agent sandbox.
 *
 * @remarks
 * Local Docker containers, in development and in production alike, so the
 * factory never depends on a hosted sandbox service. The provider labels
 * every container it creates and the janitor removes the ones whose task is
 * over.
 *
 * The post-open init marks `/workspace` as a safe git directory: the
 * container filesystem is owned by the builder uid, not the session user, so
 * without it git aborts every command with "detected dubious ownership".
 */
export const environment = IaFactorySandbox.environment({
  role: "root",
  volumeMode: "rw",
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
