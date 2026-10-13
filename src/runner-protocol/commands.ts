import { z } from "zod";
import { RunnerInputFilesSchema } from "./inputs";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const agent = z.enum(["claude", "codex", "grok"]);
const owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const repo = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => ![".", ".."].includes(name));

export const RunnerRepositorySchema = z
  .strictObject({
    owner,
    repo,
    remoteUrl: z.string().max(512),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .refine(
    (repository) =>
      repository.remoteUrl === `https://github.com/${repository.owner}/${repository.repo}.git`,
  );

export const RunnerProfileSchema = z.strictObject({
  agent,
  model: z.string().trim().min(1).max(256).nullable(),
  effort: z.string().trim().min(1).max(64).optional(),
});

const executionId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const checkText = (limit: number) =>
  z
    .string()
    .refine(
      (value) =>
        !value.includes("\0") &&
        Buffer.byteLength(value) <= limit &&
        Buffer.from(value, "utf8").toString("utf8") === value,
    );
const checkDirectory = checkText(4096).refine(
  (value) =>
    value === "." ||
    (!value.startsWith("/") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
);

const common = {
  id,
  runnerId: id,
  workspaceId: id,
  issuedAt: time,
  expiresAt: time,
};

const work = {
  runId: id,
  itemId: id,
  generation,
  repository: RunnerRepositorySchema,
  profile: RunnerProfileSchema,
  prompt: z.string().min(1).max(65_536),
  inputFiles: RunnerInputFilesSchema.optional(),
};

export const RunnerCommandSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ ...common, type: z.literal("run"), ...work }),
    z.strictObject({ ...common, type: z.literal("review"), ...work }),
    z.strictObject({
      ...common,
      type: z.literal("check"),
      runId: id,
      itemId: id,
      generation,
      repository: RunnerRepositorySchema,
      executionId,
      verificationAttemptId: executionId,
      candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
      argv: z
        .array(checkText(8192))
        .min(1)
        .max(128)
        .refine((value) => value[0]!.length > 0),
      cwd: checkDirectory,
      timeoutMs: z.number().int().min(1).max(900_000),
    }),
    z.strictObject({ ...common, type: z.literal("probe"), profile: RunnerProfileSchema }),
    z.strictObject({ ...common, type: z.literal("login_check"), agent }),
    z.strictObject({ ...common, type: z.literal("cancel"), runId: id, generation }),
    z.strictObject({
      ...common,
      type: z.literal("upgrade"),
      version: z
        .string()
        .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/)
        .max(128),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ])
  .refine((command) => command.expiresAt > command.issuedAt)
  .refine(
    (command) => command.type !== "check" || command.repository.baseSha === command.candidateSha,
  );

export const SignedRunnerCommandSchema = z.strictObject({
  keyId: id,
  payload: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(524_288),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type RunnerCommand = z.infer<typeof RunnerCommandSchema>;
export type RunnerRepository = z.infer<typeof RunnerRepositorySchema>;
export type RunnerProfile = z.infer<typeof RunnerProfileSchema>;
export type SignedRunnerCommand = z.infer<typeof SignedRunnerCommandSchema>;
