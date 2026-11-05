import { defineAgent } from "eve";
import { CONTEXT_WINDOWS, MODELS } from "./lib/models.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * The root is the orchestrator. It never writes code: it routes work between
 * the stations, asks the human the questions that need an answer, and
 * assembles the final report. Every station draws from the root session's
 * remaining quota, so the session usage limit below is the last line of
 * defence for a runaway iteration; the per-iteration budgets live in
 * `factory.config.ts` and are enforced by the pipeline code.
 */
export default defineAgent({
  compaction: {
    // Compact at 75% of the context window instead of eve's 90% default: the
    // orchestrator carries the spec, the lesson set and the station handoffs.
    threshold: 0.75,
  },
  limits: {
    // Hard stop for the whole session. The pipeline's own budgets are tighter;
    // this one exists so a misbehaving loop cannot reach the invoice.
    sessionUsage: ({ window }) =>
      window.inputTokens - window.cacheReadTokens >= 4_000_000,
    // A feature may stay open across days while a human iterates on it, so
    // the idle window is disabled.
    sessionTimeoutMs: false,
  },
  model: MODELS.root,
  // Direct provider instances have no AI Gateway catalog entry, so the
  // window is declared here: eve needs it to know when to compact.
  modelContextWindowTokens: CONTEXT_WINDOWS.root,
});
