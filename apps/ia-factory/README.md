# IA Factory

A software factory that runs on [eve](https://eve.dev), on your machine, against your own repository.

It takes a task from an IDE session, the `ia-factory` CLI or the eve TUI, and moves it through a pipeline of specialist agents: a Spec Writer that turns the task into a specification, a Builder that implements it with tests, independent analysers that review the result, and a Gatekeeper that decides whether it can reach `main` or needs a human.

```
Tarea → Spec Writer → Builder → Analysers → Approver → Gatekeeper → main | PR
```

The full design is in [`plan.md`](../../plan.md). This README covers how to run it.

## Requirements

- Node 24
- pnpm 11
- Docker (the sandboxes are local containers)
- API keys for the model providers you use

## Setup

```bash
pnpm install
cp apps/ia-factory/.env.example apps/ia-factory/.env.local
```

At minimum, `.env.local` needs:

```bash
FACTORY_REPO=owner/repo
ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY
```

For anything that writes to GitHub, add a credential:

```bash
# A fine-grained PAT limited to the repository
FACTORY_GITHUB_TOKEN=ghp_...

# Or a GitHub App, whose installation tokens are short-lived
GITHUB_APP_ID=
GITHUB_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
```

## Run

```bash
pnpm --filter @workspace/ia-factory dev
```

That starts the eve development server and the terminal UI. `/model` links a provider the first time.

To build the deployable app:

```bash
pnpm --filter @workspace/ia-factory build
```

## Verify a change

```bash
pnpm --filter @workspace/ia-factory validate   # lint + typecheck + eve info
```

## Layout

```
apps/ia-factory/
├── agent/            # the eve agent: channels, tools, subagents, skills
│   ├── lib/
│   │   ├── config.ts # the configuration contract (zod)
│   │   ├── github/   # credentials, branch validation, sandbox bootstrap
│   │   └── models.ts # one model per station
│   └── subagents/    # the stations
├── evals/            # eve eval suite
├── factory.config.ts # checks, budgets, Gatekeeper rules
└── .env.example
```

## How it differs from the template it started from

- **Local Docker sandboxes** instead of hosted ones. No Vercel account, no cloud dependency.
- **Direct provider models** with the factory's own API keys, instead of the AI Gateway.
- **No Blob, no Connect, no Linear.** The knowledge layer is the repository itself: an OKF bundle in `docs/`.

## License

MIT, from the [eve software factory template](https://github.com/vercel-labs/eve-software-factory-template). See [`LICENSE`](./LICENSE).
