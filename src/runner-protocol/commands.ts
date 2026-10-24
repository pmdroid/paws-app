import { z } from "zod";
import { RunnerInputFilesSchema, RunnerPromptContextSchema } from "./inputs";

export const RUNNER_LEASE_GRACE_MS = 5 * 60_000;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const agent = z.enum(["claude", "codex", "grok"]);
const owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const repo = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => ![".", ".."].includes(name));

export const RunnerCheckoutExclusionsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (folder) =>
          Buffer.byteLength(folder) <= 1024 &&
          !folder.includes("\\") &&
          [...folder].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
          folder
            .split("/")
            .every(
              (part) =>
                part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
            ) &&
          Buffer.from(folder, "utf8").toString("utf8") === folder,
      ),
  )
  .max(128)
  .refine((folders) => Buffer.byteLength(JSON.stringify(folders)) <= 32768);

export const RunnerRepositorySchema = z
  .strictObject({
    owner,
    repo,
    checkoutExclusions: RunnerCheckoutExclusionsSchema.optional(),
    remoteUrl: z.string().max(512),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    mainSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .refine(
    (repository) =>
      repository.remoteUrl === `https://github.com/${repository.owner}/${repository.repo}.git`,
  );

export const RunnerCheckpointBotSchema = z.strictObject({
  appId: z.string().regex(/^[1-9][0-9]*$/),
  login: z
    .string()
    .regex(/^[a-z0-9-]+\[bot\]$/)
    .max(128),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const coauthor = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  name: z.string().min(1).max(256),
  email: z.string().email().max(256),
});
export const RunnerCommitPolicySchema = z.strictObject({
  bot: RunnerCheckpointBotSchema,
  projectLead: coauthor.nullable(),
  taskSteerer: coauthor.nullable(),
});

export const RunnerProfileSchema = z.strictObject({
  agent,
  model: z.string().trim().min(1).max(256).nullable(),
  effort: z.string().trim().min(1).max(64).optional(),
});

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\0\r\n]/.test(value));
const hookEvent = z.enum(["after_edit", "before_shell", "before_tool", "stop", "session_start"]);

/** A workspace hook Paws signed into the run. The runner merges it after Closeout's Stop hook. */
export const RunnerHookSchema = z
  .strictObject({
    id,
    event: hookEvent,
    matcher: oneLine(256).nullable(),
    command: oneLine(4096),
    timeoutSeconds: z.number().int().min(1).max(600),
    agents: z
      .array(z.enum(["claude", "codex"]))
      .min(1)
      .max(2),
    skill: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
      .nullable(),
  })
  .refine((hook) => hook.matcher === null || hook.event === "before_tool");

/**
 * A runtime from the task repository's mise config on origin/main, installed by the runner
 * before the agent starts. Only mise core tools and the `aqua:` backend are carried.
 */
export const RunnerRuntimeSchema = z.strictObject({
  tool: z
    .string()
    .max(256)
    .regex(
      /^(?:node|python|go|java|ruby|rust|bun|deno|aqua:[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,3})$/,
    ),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
});

export const RunnerRuntimesSchema = z.array(RunnerRuntimeSchema).max(32);

const common = {
  id,
  runnerId: id,
  workspaceId: id,
  memberId: id.optional(),
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
  promptContext: RunnerPromptContextSchema.optional(),
  runtimes: RunnerRuntimesSchema.optional(),
};

export const RunnerCommandSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...common,
      type: z.literal("run"),
      ...work,
      skillsInputId: z.number().int().min(0).max(20).optional(),
      hooks: z.array(RunnerHookSchema).max(20).optional(),
      checkpointBot: RunnerCheckpointBotSchema.optional(),
      commitPolicy: RunnerCommitPolicySchema.optional(),
      checkpoint: z.literal(false).optional(),
      resumeSessionId: id.optional(),
    }),
    z.strictObject({ ...common, type: z.literal("review"), ...work }),
    z.strictObject({
      ...common,
      type: z.literal("task"),
      runId: id,
      itemId: id,
      generation,
      sessionId: id,
      sessionGeneration: generation,
      taskModeGeneration: generation,
      purpose: z.enum(["answer", "artifact"]),
      repository: RunnerRepositorySchema.optional(),
      profile: RunnerProfileSchema,
      prompt: work.prompt,
      inputFiles: work.inputFiles,
      promptContext: work.promptContext,
      runtimes: work.runtimes,
    }),
    z.strictObject({
      ...common,
      type: z.literal("helper"),
      sessionId: id,
      sessionGeneration: generation,
      purpose: z.enum(["classify", "select_repository"]),
      profile: RunnerProfileSchema,
      prompt: z.string().min(1).max(65_536),
    }),
    z.strictObject({ ...common, type: z.literal("probe"), profile: RunnerProfileSchema }),
    z.strictObject({ ...common, type: z.literal("login_check"), agent }),
    z.strictObject({ ...common, type: z.literal("login"), agent }),
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
  .refine(
    (command) =>
      command.type !== "run" ||
      !command.commitPolicy ||
      !command.checkpointBot ||
      (command.commitPolicy.bot.appId === command.checkpointBot.appId &&
        command.commitPolicy.bot.id === command.checkpointBot.id &&
        command.commitPolicy.bot.login === command.checkpointBot.login),
  )
  .refine(
    (command) =>
      command.type !== "run" ||
      command.skillsInputId === undefined ||
      command.inputFiles?.[command.skillsInputId]?.mimeType === "application/vnd.paws.skills+json",
  )
  .refine(
    (command) =>
      !("inputFiles" in command) ||
      (command.inputFiles?.length ?? 0) <= 20 ||
      (command.type === "run" && command.skillsInputId !== undefined),
  )
  .refine((command) => command.expiresAt > command.issuedAt)
  .refine((command) => command.type !== "login" || command.expiresAt - command.issuedAt <= 600_000)
  .refine((command) => command.type !== "helper" || command.expiresAt - command.issuedAt <= 60_000);

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
export type RunnerHook = z.infer<typeof RunnerHookSchema>;
export type RunnerRuntime = z.infer<typeof RunnerRuntimeSchema>;
export type SignedRunnerCommand = z.infer<typeof SignedRunnerCommandSchema>;
