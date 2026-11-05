import { expect, test } from "@playwright/test"

/**
 * Smoke de la app.
 *
 * Convención de títulos (plan §8.4.1): `AC-<n> · <descripción>`.
 * El prefijo es el contrato que `verify_tdd` usa para directed checks:
 * `pnpm --filter @workspace/tests e2e --grep "AC-1"`.
 */
test("AC-1 · la home muestra el título y el botón inicial", async ({ page }) => {
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Project ready!" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Button" })).toBeVisible()
})
