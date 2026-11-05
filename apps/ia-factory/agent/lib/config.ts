import { z } from "zod";

/**
 * The factory's configuration contract.
 *
 * @remarks
 * Everything the pipeline needs to run is declared here, not scattered
 * through the code: the checks a station runs, the budgets it respects, and
 * the rules the Gatekeeper applies. The file that carries the values is
 * `apps/ia-factory/factory.config.ts`.
 *
 * The schema is zod, so a malformed config fails at load with a precise
 * message instead of halfway through a task.
 */

export const SurfaceSchema = z.enum(["ui", "ux", "security", "code"]);

export const ChecksSchema = z.object({
  /**
   * Runs once per task, in the shared checkout, before any station works.
   * This is where the dependencies land: eve's `prepare` runs once per
   * template, not once per session, so the install belongs here.
   */
  setup: z.string().min(1),
  /**
   * Runs on every change, in the station sandbox. These are the gates a
   * change has to pass before it can ship.
   */
  verify: z.array(z.string().min(1)).min(1),
  /**
   * Runs one criterion of acceptance. The AC id is appended to it.
   */
  e2eForAc: z.string().min(1),
});

export const FactoryConfigSchema = z.object({
  repo: z.object({
    defaultBranch: z.string().min(1),
    branchPrefix: z.string().min(1),
    defaultBaseRef: z.string().min(1),
  }),
  brain: z.object({
    root: z.string().min(1),
    maxDocBytes: z.number().int().positive(),
    lessonPromotionThreshold: z.number().int().positive(),
    lessonsTopK: z.number().int().positive(),
  }),
  pipeline: z.object({
    /** Review cycles inside one iteration. */
    maxReviewCycles: z.number().int().positive(),
    /** Iterations of one feature. */
    maxIterations: z.number().int().positive(),
    analysers: z.object({
      ui: z.enum(["auto", "always", "never"]),
      ux: z.enum(["auto", "always", "never"]),
      security: z.enum(["auto", "always", "never"]),
      code: z.enum(["auto", "always", "never"]),
    }),
    verification: z.object({
      maxVerifications: z.number().int().positive(),
      /**
       * What an inconclusive verification means. `refuted` is not an option:
       * a real defect that the verifier could not reproduce must not
       * disappear silently.
       */
      inconclusive: z.object({
        security: z.enum(["confirmed", "rework"]),
        default: z.enum(["confirmed", "rework"]),
      }),
    }),
  }),
  gatekeeper: z.object({
    pushMaxScore: z.number().int().min(1).max(5),
    hard: z.object({
      maxChangedLines: z.number().int().positive(),
      maxChangedFiles: z.number().int().positive(),
      maxReviewCycles: z.number().int().nonnegative(),
      dependencyChanges: z.enum(["pr"]),
      nonMainBaseRef: z.enum(["pr"]),
      protectedGlobs: z.array(z.string().min(1)).min(1),
    }),
  }),
  ship: z.object({
    directPush: z.object({
      enabled: z.boolean(),
      requireApproval: z.boolean(),
      ffOnly: z.boolean(),
    }),
    pullRequest: z.object({
      draft: z.boolean(),
      labels: z.array(z.string().min(1)),
    }),
  }),
  sandbox: z.object({
    provider: z.literal("docker"),
    image: z.string().min(1),
    cpuLimit: z.number().int().positive(),
    memoryLimitMb: z.number().int().positive(),
    pidsLimit: z.number().int().positive(),
    ttlMinutes: z.number().int().positive(),
    heartbeatIntervalSeconds: z.number().int().positive(),
    sharedVolume: z.object({
      enabled: z.boolean(),
      mode: z.enum(["ro", "rw"]),
      except: z.array(z.string().min(1)),
    }),
    cleanup: z.object({
      onTerminalState: z.boolean(),
      removeVolumes: z.boolean(),
      removeWorkspace: z.boolean(),
      retryAttempts: z.number().int().nonnegative(),
      retryBackoffSeconds: z.number().int().nonnegative(),
      retainOnFailureMinutes: z.number().int().nonnegative(),
    }),
  }),
  checks: ChecksSchema,
  budgets: z.object({
    maxTokensPerIteration: z.number().int().positive(),
    maxWallClockMinutesPerIteration: z.number().int().positive(),
    maxTokensPerTask: z.number().int().positive(),
  }),
});

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

/**
 * Validates and returns the factory configuration.
 *
 * @remarks
 * Called once, at module load, so a malformed config stops the app before
 * it accepts work.
 */
export function defineFactoryConfig(config: unknown): FactoryConfig {
  return FactoryConfigSchema.parse(config);
}
