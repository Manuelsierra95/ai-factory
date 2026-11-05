# ia-factory

The IA Factory: a software factory that runs on [eve](https://eve.dev), locally, against this monorepo.

The contract for coding agents is in [`AGENTS.md`](./AGENTS.md). The design is in [`plan.md`](../../plan.md).

```bash
pnpm --filter @workspace/ia-factory dev       # eve dev (TUI)
pnpm --filter @workspace/ia-factory validate  # lint + typecheck + eve info
```
