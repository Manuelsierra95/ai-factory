import { defineTool } from "eve/tools";
import { z } from "zod";
import { sweep } from "../lib/sandbox/janitor.js";

/**
 * Removes the factory's expired sandboxes and volumes.
 *
 * @remarks
 * The janitor also runs on its own, every TTL, inside the app process. This
 * tool is the manual version: the orchestrator calls it when a task ends, or
 * a developer asks for a cleanup.
 *
 * Only resources labelled `ia-factory.managed=true` are ever touched, and a
 * task that is still working is never swept.
 */
export default defineTool({
  description:
    "Remove the factory's expired Docker sandboxes and volumes: containers and " +
    "volumes whose task is over, or whose TTL expired. Returns what it removed.",
  async execute(input) {
    const report = await sweep({
      ttlMinutes:
        input.ttlMinutes ??
        Number(process.env.FACTORY_SANDBOX_TTL_MINUTES ?? 120),
    });
    return {
      failed: report.failed,
      removedContainers: report.removedContainers,
      removedVolumes: report.removedVolumes,
      success: report.failed.length === 0,
    };
  },
  inputSchema: z.object({
    ttlMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How long a sandbox may live without a heartbeat. Defaults to the configured TTL.",
      ),
  }),
});
