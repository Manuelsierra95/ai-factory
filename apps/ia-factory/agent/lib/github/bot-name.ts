/**
 * The name the factory commits as.
 *
 * @remarks
 * A hardcoded name is wrong in general, because the App slug belongs to
 * whoever registered it and a guessed handle can collide with a real GitHub
 * user. Here the name comes from the environment, which the deployer owns:
 * `FACTORY_BOT_NAME`, then `GITHUB_APP_SLUG`. When neither is set, the
 * fallback keeps the commit identity usable.
 */
export const FALLBACK_BOT_NAME = "IA Factory";

/**
 * Upper bound on a resolved bot name before it is interpolated into a
 * regular expression.
 */
const MAX_BOT_NAME_LENGTH = 80;

/**
 * The name the factory answers to.
 *
 * @remarks
 * Resolution is explicit rather than discovered: the factory runs locally,
 * so the developer names their own App.
 */
export async function resolveBotName(): Promise<string> {
  const override = process.env.FACTORY_BOT_NAME ?? process.env.GITHUB_APP_SLUG;
  if (override && override.length <= MAX_BOT_NAME_LENGTH) {
    return override;
  }
  return FALLBACK_BOT_NAME;
}

/**
 * Builds the mention matcher for a resolved bot name: `@<name>` on a word
 * boundary, the same shape the channel's built-in comment gate uses.
 *
 * @remarks
 * The name is escaped for literal matching before interpolation and its
 * length is bounded, so environment-supplied data can never change the
 * pattern's meaning.
 */
export function mentionPattern(botName: string): RegExp {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu");
}
