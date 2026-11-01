import { z } from "zod";

export const LIVE_PREVIEW_TIME_LIMIT_MINUTES = 60;

export function livePreviewSecretName(name: string): boolean {
  return /^(PAWS_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|XAI_|GROK_|OPENCODE_|GH_|GITHUB_|LINEAR_|SLACK_|AWS_|TS_|TAILSCALE_)|TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|PRIVATE_KEY/i.test(
    name,
  );
}

const oneLine = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));

export const RunnerLivePreviewSchema = z.strictObject({
  command: oneLine,
  port: z.number().int().min(1024).max(65_535),
  path: z
    .string()
    .max(2048)
    .regex(/^\/[\x21-\x7e]*$/)
    .optional(),
  timeLimitMinutes: z.number().int().min(1).max(240).optional(),
  fixtures: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
        .refine((name) => !livePreviewSecretName(name)),
      z
        .string()
        .max(4096)
        .refine((value) => !value.includes("\0")),
    )
    .refine((fixtures) => Object.keys(fixtures).length <= 64)
    .optional(),
});

export const LIVE_PREVIEW_STOP_REASONS = ["time_limit", "run_ended", "exited", "failed"] as const;

const service = z.string().regex(/^paws-preview-[a-z0-9]{1,40}-[1-9][0-9]{0,2}$/);

export const RunnerPreviewEventSchema = z
  .strictObject({
    type: z.literal("preview"),
    state: z.enum(["starting", "ready", "stopped"]),
    service: service.optional(),
    url: z
      .string()
      .max(2048)
      .regex(
        /^https:\/\/paws-preview-[a-z0-9]{1,40}-[1-9][0-9]{0,2}\.[A-Za-z0-9.-]+\/[\x21-\x7e]*$/,
      )
      .optional(),
    reason: z.enum(LIVE_PREVIEW_STOP_REASONS).optional(),
    message: z.string().min(1).max(1024).optional(),
  })
  .refine(
    (event) =>
      (event.state === "starting" && !!event.service && !event.url && !event.reason) ||
      (event.state === "ready" && !!event.service && !!event.url && !event.reason) ||
      (event.state === "stopped" && !!event.reason && !event.url),
  );

export type RunnerLivePreview = z.infer<typeof RunnerLivePreviewSchema>;
export type RunnerPreviewEvent = z.infer<typeof RunnerPreviewEventSchema>;
export type LivePreviewStopReason = (typeof LIVE_PREVIEW_STOP_REASONS)[number];
