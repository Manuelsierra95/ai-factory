import { defineConfig } from "vitest/config";

/**
 * Test configuration for the factory.
 *
 * @remarks
 * The sandbox provider's tests talk to the real Docker daemon: they pull an
 * image, start containers and commit templates. That takes minutes on a cold
 * machine, so the timeout is generous.
 *
 * The files run one at a time, because they share the daemon and the
 * container names.
 */
export default defineConfig({
  test: {
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
