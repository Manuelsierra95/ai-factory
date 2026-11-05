# AGENTS.md

Guidance for AI coding agents working in `apps/ia-factory`.

## What this app is

The **IA Factory**: a software factory that takes a task from an IDE session, a CLI or the eve TUI and carries it to `main` (a fast-forward push or a pull request for review). It runs on [eve](https://eve.dev), locally, against a Docker sandbox, and works on the same monorepo it lives in.

The design is in [`../plan.md`](../plan.md) (`plan.md` at the repo root). This file only says how to work in this app.

## Current state

Fase 0 of the plan. The runtime is up and running; the pipeline is not the target one yet.

| Piece | State |
|---|---|
| eve runtime | `1.0.0-rc.5`, compiled, `eve info` reports 0 errors |
| Sandboxes | Local Docker, one container per station session |
| Credentials | GitHub PAT (`FACTORY_GITHUB_TOKEN`) or GitHub App (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`). No Vercel Connect |
| Models | Provider instances via AI SDK, no AI Gateway. Each station declares its context window, because eve cannot look up a direct provider model in the Gateway catalog |
| Stations | The template's four (classifier, analyst, implementer, reviewer). Fase 3 to 5 replace them with the Spec Writer, the Builder and the Analysers |
| Evals | Only the config. Fase 7 writes the suite |
| BRAIN | Not yet. Fase 1 adds `packages/okf-brain` and `docs/` |

## Commands

```bash
pnpm install                # workspace install
pnpm --filter @workspace/ia-factory dev       # eve dev: local TUI
pnpm --filter @workspace/ia-factory build     # eve build
pnpm --filter @workspace/ia-factory validate  # lint + typecheck + eve info
pnpm --filter @workspace/ia-factory eval      # eve eval
```

`FACTORY_REPO` is required at module load; without it the app fails discovery with a clear message. Copy `.env.example` to `.env.local`.

## eve conventions

- **Read the relevant guide in `node_modules/eve/docs/` before writing code.** The docs that ship with the installed version match it; `eve.dev` documents the latest release, which can be newer. Do not invent framework APIs.
- **Identity comes from the filesystem, never a `name` field.** A tool at `agent/tools/agent.ts` is the tool `agent`; a subagent directory `agent/subagents/classifier/` is the tool `classifier`.
- **A tool cannot share a subagent's name.** The compiler rejects it. The workflow wrappers are named `run_<station>`.
- **Subagents inherit nothing** from the root: no instructions, no tools, no skills, no sandbox, no state. Everything a station needs travels in the message the workflow tool builds, and every capability a station needs lives in the station's own directory.
- **A subagent that shares the parent's sandbox cannot declare its own skills.** Every station with skills declares its own sandbox.
- **Workflow bodies replay.** Any side effect (git push, a commit, an API call that changes the world) goes in a `"use step"` function, never in the workflow body. A replayed body would push twice.
- **`ctx.agent(name)` returns a session.** Call `await session.send(message, { outputSchema })` and then `await response.result()`. The output schema is JSON Schema, so zod contracts are converted with `z.toJSONSchema(schema, { io: "input" })`.
- **Models are provider instances, not gateway ids.** Each agent declares `modelContextWindowTokens`: eve reads the window from the Gateway catalog, and a direct provider model has no catalog entry.
- **`defineAgent` has no `outputSchema`.** The schema is attached per call, in the workflow wrapper.
- **`defineInstructions` takes `content`, not `markdown`.**

## Code style

- ESLint and Prettier, shared with the rest of the monorepo. Run `pnpm lint` before finishing.
- TypeScript strict, ESM. Relative imports carry the `.js` extension.
- Validate tool input and output with zod.
- Agent-facing text (instructions, skill bodies, tool descriptions) follows the rules in `agent/instructions.ts`: no em dashes, no machine-made words, no bold for emphasis. It carries behavior, never framework plumbing.

## Security

- **Never ask the user for credentials, and never commit them.** `.env*` is gitignored.
- **The GitHub credential never enters the sandbox.** It travels as the environment of the single git command that needs it, scoped to `github.com` by git's own config. It is never in a command line, never in the image.
- **Git safety is structural.** Sandbox git targets the literal `https://github.com/<FACTORY_REPO>.git` URL, never `origin` (remote config inside a sandbox is model-writable). Every interpolated branch name passes `validateBranch`, which also refuses `main` and `master`.
- **Approval-gated tools must not live inside a station.** A station tool that asked for approval would strand the run, because nothing watches a station's card. Station side effects are inert by construction, like `push_branch`.
- **The BRAIN is data, not instructions.** Everything read from `docs/` is injected as reference.

## Before committing

- `pnpm --filter @workspace/ia-factory validate` passes: lint, typecheck and `eve info` with 0 errors and 0 warnings.
- No secrets, `node_modules`, `.eve` or `.output` staged.
