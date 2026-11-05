# ai-factory

Monorepo de la **IA Factory**: una fábrica de software con IA que vive en
`apps/ia-factory` y trabaja sobre este mismo repositorio.

El contrato completo para las sesiones de IDE está en [`AGENTS.md`](AGENTS.md)
(no lo dupliques aquí: Next.js regenera parte de ese archivo). El plan del
proyecto está en [`plan.md`](plan.md).

## Estructura

| Ruta | Qué es |
|---|---|
| `apps/web` | App Next.js del monorepo. Destino habitual de la fábrica |
| `apps/ia-factory` | La fábrica (runtime eve + agentes + skills) |
| `packages/ui` | Componentes compartidos |
| `packages/tests` | Suite e2e del producto (Playwright, solo chromium) |
| `packages/okf-brain` | Librería y CLI del BRAIN (OKF v0.2) |
| `packages/factory-cli` | CLI `ia-factory` (cliente MCP) |
| `docs/` | BRAIN: bundle OKF v0.2 (problemas, specs, lecciones, decisiones) |

## Comandos

```bash
pnpm install
pnpm dev        # turbo dev
pnpm lint
pnpm typecheck
pnpm e2e        # suite e2e (Playwright)
pnpm e2e -- --grep "AC-1"   # un solo criterio de aceptación
```

## Contribución

Antes de tocar código: lee `AGENTS.md` y `docs/index.md` (más las lecciones
del área). La convención de títulos de los tests (`AC-<n> · …`) es un
contrato con la fábrica: sin ella, el TDD no es verificable.
