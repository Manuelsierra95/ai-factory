import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

/**
 * One place to change every agent's model.
 *
 * @remarks
 * Each `agent.ts` reads its entry here instead of hardcoding a model, so a
 * model swap is a one-line edit in this file.
 *
 * Two rules are deliberate:
 *
 * 1. The builder gets the strongest coding model.
 * 2. The code analyser and the finding verifier run on a different vendor
 *    than the builder, so the review stays independent of the implementation
 *    that produced the diff.
 *
 * These are provider instances, not gateway ids: the factory carries its own
 * API keys and never routes through the AI Gateway.
 */
export const MODELS = {
  root: anthropic("claude-sonnet-5"),
  analyst: anthropic("claude-sonnet-5"),
  classifier: openai("gpt-5.5-mini"),
  implementer: anthropic("claude-opus-5.5"),
  researcher: openai("gpt-5.5-mini"),
  reviewer: openai("gpt-5.5"),
} as const;

/**
 * Context window per station, in tokens.
 *
 * @remarks
 * eve reads this from the AI Gateway catalog when the model is a gateway id.
 * The factory calls providers directly, so no catalog entry exists and the
 * build fails with "does not have known AI Gateway context window metadata"
 * unless every agent declares its own window.
 */
export const CONTEXT_WINDOWS = {
  root: 200_000,
  analyst: 200_000,
  classifier: 400_000,
  implementer: 200_000,
  researcher: 400_000,
  reviewer: 400_000,
} as const;

export type FactoryAgent = keyof typeof MODELS;
