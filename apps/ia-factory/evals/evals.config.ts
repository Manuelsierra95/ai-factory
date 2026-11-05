import { openai } from "@ai-sdk/openai";
import { defineEvalConfig } from "eve/evals";

/**
 * Run-wide eval defaults.
 *
 * @remarks
 * The judge scores `t.judge(...)` assertions only; it never changes the
 * behaviour under test. It is a provider decision model, not a gateway id:
 * the factory carries its own API keys and never routes through the AI
 * Gateway.
 *
 * Fase 7 of the plan replaces this suite with the categories described there
 * (routing, safety, brain, verification, pipeline, iteration, skills, e2e).
 */
export default defineEvalConfig({
  judge: { model: openai.decisionModel("gpt-6-luna") },
});
