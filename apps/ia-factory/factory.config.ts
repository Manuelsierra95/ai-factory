import { defineFactoryConfig } from "./agent/lib/config.js";

/**
 * The factory's configuration.
 *
 * @remarks
 * Everything the pipeline reads at runtime lives here. The values are the
 * plan's defaults; each one is a decision with a reason, not a magic number
 * scattered through the code.
 */
export default defineFactoryConfig({
  repo: {
    defaultBranch: "main",
    branchPrefix: "factory/",
    defaultBaseRef: "main",
  },
  brain: {
    root: "docs",
    maxDocBytes: 32_000,
    lessonPromotionThreshold: 3,
    lessonsTopK: 8,
  },
  pipeline: {
    // Review cycles inside one iteration.
    maxReviewCycles: 3,
    // Iterations of one feature. A feature that never converges escalates
    // with a report; it never closes silently.
    maxIterations: 8,
    analysers: {
      ui: "auto",
      ux: "auto",
      security: "always",
      code: "always",
    },
    verification: {
      maxVerifications: 10,
      // An inconclusive verification blocks. A real defect that the verifier
      // could not reproduce must not disappear silently.
      inconclusive: { security: "confirmed", default: "rework" },
    },
  },
  gatekeeper: {
    pushMaxScore: 2,
    hard: {
      maxChangedLines: 200,
      maxChangedFiles: 8,
      maxReviewCycles: 1,
      dependencyChanges: "pr",
      nonMainBaseRef: "pr",
      protectedGlobs: [
        "apps/ia-factory/**",
        "**/auth/**",
        "**/migrations/**",
        "infra/**",
        ".github/**",
        "**/*.env*",
        "docs/conventions/**",
      ],
    },
  },
  ship: {
    directPush: { enabled: true, requireApproval: false, ffOnly: true },
    pullRequest: { draft: false, labels: ["ia-factory"] },
  },
  sandbox: {
    provider: "docker",
    // Pinned by digest. The tag moves: the same tag served a root user in
    // one moment and a non-root user in the next, and a sandbox that works
    // on one machine fails on another. The plan's own image (Playwright
    // browsers included, no passwordless sudo) is the target.
    image:
      "ghcr.io/vercel/eve@sha256:35014dfac4d298d471b523878a6cf3bf171be42a2caaf8de7aa31eb7001f1145",
    cpuLimit: 4,
    memoryLimitMb: 8192,
    pidsLimit: 512,
    ttlMinutes: 120,
    heartbeatIntervalSeconds: 30,
    // One clone and one install per task: the Builder writes the shared
    // checkout, every other station mounts it read-only.
    sharedVolume: { enabled: true, mode: "ro", except: ["builder"] },
    cleanup: {
      onTerminalState: true,
      removeVolumes: true,
      removeWorkspace: true,
      retryAttempts: 5,
      retryBackoffSeconds: 30,
      retainOnFailureMinutes: 0,
    },
  },
  checks: {
    // Once per task, in the shared checkout.
    setup:
      "pnpm install --frozen-lockfile && pnpm --filter web build && pnpm --filter @workspace/tests exec playwright install --with-deps chromium",
    // On every change, in the station sandbox.
    verify: [
      "pnpm --filter web lint",
      "pnpm --filter web typecheck",
      "pnpm --filter @workspace/tests e2e",
    ],
    // One criterion of acceptance; the AC id is appended.
    e2eForAc: "pnpm --filter @workspace/tests e2e --grep",
  },
  budgets: {
    maxTokensPerIteration: 2_000_000,
    maxWallClockMinutesPerIteration: 90,
    maxTokensPerTask: 8_000_000,
  },
});
