import { defineConfig, devices } from "@playwright/test"

/**
 * Suite e2e del monorepo (D35: vive en `packages/tests`).
 *
 * Contrato con la fábrica (plan §8.4.1): cada test empieza por el id del
 * criterio de aceptación, `AC-<n> · <descripción>`. `verify_tdd` ejecuta
 * **solo** el AC afectado con `--grep`, que es lo que hace que el TDD sea
 * verificable sin pagar la suite entera en cada ciclo.
 *
 * Solo `chromium` (D34): una sola instalación, la misma que usan los
 * analysers UI/UX (D36), que levantan su propia app con `FACTORY_PREVIEW_COMMAND`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3101)
// `localhost` y no `127.0.0.1`: Next bloquea los recursos de dev cross-origin
// y el warning ensucia la salida del test.
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`
const isCI = Boolean(process.env.CI)

export default defineConfig({
  testDir: "./e2e",
  // Un solo worker en CI: el `webServer` es único y los tests comparten la app.
  workers: isCI ? 1 : undefined,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next dev` en un puerto propio: no choca con el servidor del desarrollador.
    // `exec` (y no `dev --`) para que el puerto llegue a `next` sin el `--` de pnpm.
    command: `pnpm --filter web exec next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
