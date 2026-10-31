import { z } from "zod";

/** The coding agents the runner installer installs into `/opt/paws-runner/agents/<agent>`. */
export const RUNNER_CODING_AGENTS = ["claude", "codex", "grok", "opencode"] as const;
export type RunnerCodingAgent = (typeof RUNNER_CODING_AGENTS)[number];

const agent = z.enum(RUNNER_CODING_AGENTS);
/** An exact npm version, the same rule as `EXACT_VERSION` in `deploy/linux/release.py`. */
export const RunnerAgentVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

/**
 * An agent version Paws asks a runner to run, sent in the heartbeat reply. `integrity` is the npm
 * sha512 of the agent package from the Paws catalog; the root installer refuses a lockfile that
 * resolves anything else. `id` changes with every request, so a failed request is retried only
 * when someone asks again.
 */
export const RunnerAgentTargetSchema = z.strictObject({
  id,
  agent,
  version: RunnerAgentVersionSchema,
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  nativeVersion: RunnerAgentVersionSchema.nullable(),
  /**
   * The native build package and the platform packages it pins, each with the integrity the
   * catalog checked. The installer refuses a lockfile that resolves any of them with other bytes.
   */
  packages: z
    .array(
      z.strictObject({
        name: z
          .string()
          .max(214)
          .regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/),
        version: RunnerAgentVersionSchema,
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
      }),
    )
    .min(1)
    .max(64),
});

export const RunnerAgentTargetsSchema = z
  .array(RunnerAgentTargetSchema)
  .max(RUNNER_CODING_AGENTS.length)
  .refine((targets) => new Set(targets.map((target) => target.agent)).size === targets.length);

/**
 * An agent version as the runner reports it in its heartbeat. `current` is the version new
 * sessions start. `previous` is only sent by older runners, and Paws ignores it. The others answer the target `target`: `installing`, `waiting` while `sessions` still run on the old
 * version, or `failed` with `error`.
 */
export const RunnerInstalledAgentSchema = z.strictObject({
  agent,
  version: RunnerAgentVersionSchema,
  status: z.enum(["current", "previous", "installing", "waiting", "failed"]),
  target: id.optional(),
  sessions: z.number().int().min(0).max(1024).optional(),
  error: z.string().min(1).max(500).optional(),
});

export const RunnerInstalledAgentsSchema = z.array(RunnerInstalledAgentSchema).max(16);

export type RunnerAgentTarget = z.infer<typeof RunnerAgentTargetSchema>;
export type RunnerInstalledAgent = z.infer<typeof RunnerInstalledAgentSchema>;
