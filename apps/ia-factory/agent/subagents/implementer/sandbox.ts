import { defineSandbox } from "eve/sandbox";
import {
  createFactoryEnvironment,
  factoryClone,
  factoryInit,
} from "../../lib/github/repo-sandbox.js";

/**
 * Implementer sandbox: a ready-to-work checkout of the factory repository.
 *
 * @remarks
 * Declared subagents share nothing with the root, so each station that needs
 * the repository authors its own sandbox from the shared builders in
 * `agent/lib/github/repo-sandbox.ts`.
 *
 * The builder is the only writer: it clones the repository into the shared
 * volume and runs the setup command there, so the checkout and the install
 * happen once per task. The other stations mount the same volume read-only.
 */
export const environment = createFactoryEnvironment("builder");

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await factoryInit(sandbox);
  await factoryClone(sandbox);
  return sandbox;
});
