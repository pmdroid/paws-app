import { lstatSync, readdirSync, rmSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { PawsPaths } from "../config";
import { randomUUID } from "node:crypto";
import {
  answerStorageCleanupPreviewSteps,
  closeoutLogCandidates,
  expireStorageCleanupsSteps,
  finishStorageCleanupSteps,
  lastStorageCleanupStartedSteps,
  listStorageCleanupsSteps,
  readSetting,
  readStorageCleanupPreviewSteps,
  removeCloseoutOutputs,
  saveStorageCleanupPreviewSteps,
  startStorageCleanupSteps,
  storageCleanupPendingSteps,
  storageCleanupRunnerSteps,
  takeStorageCleanupPreviewSteps,
  updateSetting,
  workItemStatesSteps,
  type Db,
  type ExpiredCloseoutOutput,
  type Q,
  type StorageCleanupPreviewRow,
  type Steps,
} from "../db";
import { journalCaught } from "../journal";
import {
  RunnerStorageCleanupResultSchema,
  STORAGE_CLEANUP_RUNNER_VERSION,
  runnerReleaseAtLeast,
  type RunnerCommand,
} from "../runner-protocol";
import { SERVER_MACHINE } from "../storage-usage";
import { readWebhookBody } from "../webhook-body";

export const CLEANUP_CATEGORIES = ["temporary", "closeout_logs", "worker_logs"] as const;
const SERVER_CATEGORIES: readonly CleanupCategory[] = ["temporary", "closeout_logs"];
const RUNNER_CATEGORIES: readonly CleanupCategory[] = ["worker_logs"];
export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];
export const STORAGE_CLEANUP_KEY = "storage.cleanup";
export const STORAGE_CLEANUP_JOB = "storage.cleanup.schedule";
export const STORAGE_CLEANUP_TICK_MS = 5 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PREVIEW_MS = 15 * 60_000;
const OWNERLESS_MS = 7 * DAY;
const LIMIT = 10_000;
const COMMAND_MS = DAY;
const ACTIVE = new Set(["running", "queued", "paused", "recovering", "verifying"]);
const OWNED = /^paws-[a-z]+-([0-9A-HJKMNP-TV-Z]{26})-/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MACHINE = /^[A-Za-z0-9._:-]{1,128}$/;

export type CleanupSettings = {
  schedule: { enabled: boolean; timeUtc: string; machines: string[] };
  categories: {
    temporary: { enabled: boolean; olderThanHours: number };
    closeout_logs: { enabled: boolean };
    worker_logs: { enabled: boolean; olderThanDays: number };
  };
};

export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
  schedule: { enabled: false, timeUtc: "03:00", machines: [] },
  categories: {
    temporary: { enabled: true, olderThanHours: 24 },
    closeout_logs: { enabled: true },
    worker_logs: { enabled: false, olderThanDays: 7 },
  },
};

export type CleanupItem = { category: CleanupCategory; ref: string; bytes: number };
export type CleanupSkip = { category: CleanupCategory; ref: string; reason: string };
export type CleanupKept = { category: CleanupCategory; reason: string; count: number };
export type CleanupPreview = {
  id: string;
  expiresAt: number;
  items: CleanupItem[];
  kept: CleanupKept[];
};
export type CleanupReply = { status: number; body: unknown };
export type CleanupRunners = { enqueueSteps(q: Q, command: RunnerCommand): Steps<unknown> };

class Refused extends Error {
  constructor(readonly reply: CleanupReply) {
    super("Storage cleanup refused");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCleanupSettings(value: unknown): CleanupSettings | string {
  if (!isRecord(value) || !isRecord(value.schedule) || !isRecord(value.categories))
    return "Expected schedule and categories.";
  const { schedule, categories } = value;
  const unknown = Object.keys(categories).find(
    (key) => !(CLEANUP_CATEGORIES as readonly string[]).includes(key),
  );
  if (unknown !== undefined) return `${unknown} is not a cleanup category.`;
  if (typeof schedule.enabled !== "boolean") return "schedule.enabled must be true or false.";
  if (typeof schedule.timeUtc !== "string" || !TIME.test(schedule.timeUtc))
    return "schedule.timeUtc must be a time such as 03:00.";
  const machines = schedule.machines;
  if (!Array.isArray(machines) || !machines.every((m) => typeof m === "string" && MACHINE.test(m)))
    return 'schedule.machines must list "server" and runner ids.';
  const { temporary, closeout_logs: logs } = categories;
  const hours = isRecord(temporary) ? temporary.olderThanHours : undefined;
  if (
    !isRecord(temporary) ||
    typeof temporary.enabled !== "boolean" ||
    typeof hours !== "number" ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 8760
  )
    return "categories.temporary needs enabled and olderThanHours from 1 to 8760.";
  if (!isRecord(logs) || typeof logs.enabled !== "boolean")
    return "categories.closeout_logs needs enabled.";
  const workers = categories.worker_logs ?? DEFAULT_CLEANUP_SETTINGS.categories.worker_logs;
  const days = isRecord(workers) ? workers.olderThanDays : undefined;
  if (
    !isRecord(workers) ||
    typeof workers.enabled !== "boolean" ||
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3650
  )
    return "categories.worker_logs needs enabled and olderThanDays from 1 to 3650.";
  return {
    schedule: {
      enabled: schedule.enabled,
      timeUtc: schedule.timeUtc,
      machines: [...new Set(machines as string[])],
    },
    categories: {
      temporary: { enabled: temporary.enabled, olderThanHours: hours },
      closeout_logs: { enabled: logs.enabled },
      worker_logs: { enabled: workers.enabled, olderThanDays: days },
    },
  };
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sizeOf(path: string): number {
  const stats = lstatOrNull(path);
  if (!stats) return 0;
  let bytes = Number(stats.blocks) * 512;
  if (stats.isDirectory())
    try {
      for (const name of readdirSync(path)) bytes += sizeOf(join(path, name));
    } catch {
      return bytes;
    }
  return bytes;
}

function outputRef(output: ExpiredCloseoutOutput): string {
  const ref = output.ref;
  return ref.table === "closeout_step"
    ? `closeout_step/${ref.progressId}/${ref.stepId}`
    : `agent_closeout_event/${ref.runId}/${ref.sequence}`;
}

export function lastScheduledAt(timeUtc: string, now: number): number {
  const [hours, minutes] = timeUtc.split(":").map(Number) as [number, number];
  const day = new Date(now);
  const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes);
  return at <= now ? at : at - DAY;
}

export type StorageCleanupOptions = {
  paths: PawsPaths;
  store: Db;
  removeCloseoutLog: (key: string) => Promise<void>;
  runners?: () => Promise<CleanupRunners | undefined>;
  now?: () => number;
};

export type StorageCleanup = ReturnType<typeof createStorageCleanup>;

export function createStorageCleanup(options: StorageCleanupOptions) {
  const { paths, store } = options;
  const now = options.now ?? Date.now;

  const settings = async (): Promise<CleanupSettings> => {
    const stored = await readSetting(store, STORAGE_CLEANUP_KEY);
    if (stored === null) return DEFAULT_CLEANUP_SETTINGS;
    try {
      const parsed = parseCleanupSettings(JSON.parse(stored));
      return typeof parsed === "string" ? DEFAULT_CLEANUP_SETTINGS : parsed;
    } catch {
      return DEFAULT_CLEANUP_SETTINGS;
    }
  };

  const temporary = async (names: string[], olderThanHours: number, at: number) => {
    const owners = [...new Set(names.flatMap((name) => OWNED.exec(name)?.[1] ?? []))];
    const states = await store.run((q) => workItemStatesSteps(q, owners));
    return names.map((name): CleanupItem | CleanupSkip => {
      const category = "temporary" as const;
      const stats = basename(name) === name ? lstatOrNull(join(paths.tmpDir, name)) : null;
      if (!stats) return { category, ref: name, reason: "already gone" };
      const owner = OWNED.exec(name)?.[1];
      const state = owner === undefined ? undefined : states.get(owner);
      const age = at - stats.mtimeMs;
      if (state !== undefined && ACTIVE.has(state))
        return { category, ref: name, reason: `owner is ${state}` };
      if (age < olderThanHours * HOUR)
        return { category, ref: name, reason: `newer than ${olderThanHours} hours` };
      if (state === undefined && age < OWNERLESS_MS)
        return { category, ref: name, reason: "no known owner, newer than 7 days" };
      return { category, ref: name, bytes: sizeOf(join(paths.tmpDir, name)) };
    });
  };

  const listTemporary = () => {
    try {
      return readdirSync(paths.tmpDir);
    } catch {
      return [];
    }
  };

  const preview = async (machine: string, categories: CleanupCategory[]) => {
    const at = now();
    const rules = await settings();
    const items: CleanupItem[] = [];
    const kept = new Map<string, CleanupKept>();
    if (categories.includes("temporary"))
      for (const entry of await temporary(
        listTemporary(),
        rules.categories.temporary.olderThanHours,
        at,
      )) {
        if ("bytes" in entry) items.push(entry);
        else {
          const group = kept.get(entry.reason);
          if (group) group.count += 1;
          else kept.set(entry.reason, { category: entry.category, reason: entry.reason, count: 1 });
        }
      }
    if (categories.includes("closeout_logs"))
      for (const output of await closeoutLogCandidates(store, at, LIMIT))
        items.push({ category: "closeout_logs", ref: outputRef(output), bytes: output.bytes });
    const expiresAt = at + PREVIEW_MS;
    const body = { machine, categories, items, kept: [...kept.values()], expiresAt };
    const id = await store.transaction((q) => saveStorageCleanupPreviewSteps(q, body, at));
    return { id, expiresAt, items, kept: body.kept } satisfies CleanupPreview;
  };

  const execute = async (
    machine: string,
    categories: CleanupCategory[],
    items: CleanupItem[],
    actor: string,
  ) => {
    const startedAt = now();
    const id = await store.transaction((q) =>
      startStorageCleanupSteps(q, {
        machine,
        actor,
        startedAt,
        finishedAt: null,
        categories,
        deleted: [],
        skipped: [],
        freedBytes: 0,
        error: null,
      }),
    );
    const deleted: CleanupItem[] = [];
    const skipped: CleanupSkip[] = [];
    let error: string | null = null;
    try {
      const rules = await settings();
      const previewed = (category: CleanupCategory) =>
        items.filter((item) => item.category === category);
      for (const item of previewed("temporary")) {
        const hours = rules.categories.temporary.olderThanHours;
        const checked = (await temporary([item.ref], hours, now()))[0]!;
        if (!("bytes" in checked)) {
          skipped.push(checked);
          continue;
        }
        try {
          rmSync(join(paths.tmpDir, item.ref), { recursive: true, force: true });
          deleted.push(checked);
        } catch (caught) {
          skipped.push({ ...item, reason: caught instanceof Error ? caught.message : "failed" });
        }
      }
      const logs = previewed("closeout_logs");
      const current = new Map(
        logs.length === 0
          ? []
          : (await closeoutLogCandidates(store, now(), LIMIT)).map((o) => [outputRef(o), o]),
      );
      for (const item of logs) {
        const output = current.get(item.ref);
        if (!output) {
          skipped.push({ ...item, reason: "no longer past Closeout log retention" });
          continue;
        }
        await removeCloseoutOutputs(store, [output], options.removeCloseoutLog);
        deleted.push({ ...item, bytes: output.bytes });
      }
    } catch (caught) {
      journalCaught(caught, "storage-cleanup.run", null);
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const result = {
      finishedAt: now(),
      deleted,
      skipped,
      freedBytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
      error,
    };
    await store.transaction((q) => finishStorageCleanupSteps(q, id, result));
    return { id, machine, actor, startedAt, categories, ...result };
  };

  const refusing = async (work: () => Promise<CleanupReply>): Promise<CleanupReply> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Refused) return error.reply;
      throw error;
    }
  };

  function* targetSteps(q: Q, machine: string, at: number): Steps<string> {
    const target = yield* storageCleanupRunnerSteps(q, machine);
    if (!target) throw new Refused({ status: 404, body: { error: "No such runner." } });
    if (!runnerReleaseAtLeast(target.version, STORAGE_CLEANUP_RUNNER_VERSION))
      throw new Refused({
        status: 409,
        body: { state: "unsupported", error: "This runner is too old to clean up worker logs." },
      });
    if (yield* storageCleanupPendingSteps(q, machine, at, at - COMMAND_MS))
      throw new Refused({
        status: 409,
        body: { error: "This runner already has a cleanup waiting." },
      });
    return target.workspaceId;
  }

  const command = (
    machine: string,
    workspaceId: string,
    input: { cleanupId: string; mode: "preview" | "run"; olderThanDays: number; items?: string[] },
    at: number,
  ): RunnerCommand => ({
    id: randomUUID(),
    type: "storage.cleanup",
    runnerId: machine,
    workspaceId,
    issuedAt: at,
    expiresAt: at + COMMAND_MS,
    category: "worker_logs",
    ...input,
  });

  const connected = async () => {
    const runners = await options.runners?.();
    if (!runners) throw new Refused({ status: 503, body: { error: "Runners are not available." } });
    return runners;
  };

  const previewRunner = (machine: string, actor: string | null) =>
    refusing(async () => {
      const runners = await connected();
      const { olderThanDays } = (await settings()).categories.worker_logs;
      const at = now();
      const expiresAt = at + COMMAND_MS;
      const id = await store.transaction(function* (q) {
        const workspaceId = yield* targetSteps(q, machine, at);
        const pending = { machine, categories: RUNNER_CATEGORIES, items: [], kept: [] };
        const cleanupId = yield* saveStorageCleanupPreviewSteps(
          q,
          { ...pending, expiresAt, pending: true, actor },
          at,
        );
        const mode = "preview";
        yield* runners.enqueueSteps(
          q,
          command(machine, workspaceId, { cleanupId, mode, olderThanDays }, at),
        );
        return cleanupId;
      });
      return { status: 202, body: { id, machine, pending: true, expiresAt } };
    });

  const runRunner = (row: StorageCleanupPreviewRow, actor: string) =>
    refusing(async () => {
      const runners = await connected();
      const { olderThanDays } = (await settings()).categories.worker_logs;
      const at = now();
      const categories = row.categories as CleanupCategory[];
      const cleanup = {
        machine: row.machine,
        actor,
        startedAt: at,
        finishedAt: null,
        categories,
        deleted: [],
        skipped: [],
        freedBytes: 0,
        error: null,
      };
      const items = (row.items as CleanupItem[]).map((item) => item.ref);
      const id = await store.transaction(function* (q) {
        const workspaceId = yield* targetSteps(q, row.machine, at);
        const cleanupId = yield* startStorageCleanupSteps(q, cleanup);
        yield* runners.enqueueSteps(
          q,
          command(row.machine, workspaceId, { cleanupId, mode: "run", olderThanDays, items }, at),
        );
        return cleanupId;
      });
      return { status: 202, body: { id, ...cleanup, pending: true } };
    });

  const run = async (previewId: string, actor: string): Promise<CleanupReply> => {
    const row = await store.transaction((q) => takeStorageCleanupPreviewSteps(q, previewId));
    if (!row) {
      const waiting = await store.run((q) => readStorageCleanupPreviewSteps(q, previewId));
      if (waiting?.pending)
        return { status: 409, body: { error: "The runner has not answered this preview yet." } };
      return { status: 404, body: { error: "No such cleanup preview." } };
    }
    if (row.expiresAt <= now())
      return { status: 410, body: { error: "This preview expired. Preview again." } };
    if (row.machine !== SERVER_MACHINE) return runRunner(row, actor);
    const body = await execute(
      row.machine,
      row.categories as CleanupCategory[],
      row.items as CleanupItem[],
      actor,
    );
    return { status: 200, body };
  };

  const enabledCategories = (rules: CleanupSettings, machine: string) =>
    (machine === SERVER_MACHINE ? SERVER_CATEGORIES : RUNNER_CATEGORIES).filter(
      (category) => rules.categories[category].enabled,
    );

  return {
    settings,
    async save(body: unknown): Promise<CleanupReply> {
      const parsed = parseCleanupSettings(body);
      if (typeof parsed === "string") return { status: 400, body: { error: parsed } };
      await updateSetting(store, STORAGE_CLEANUP_KEY, () => JSON.stringify(parsed), now());
      return { status: 200, body: parsed };
    },
    async preview(body: unknown): Promise<CleanupReply> {
      const { machine, categories } = isRecord(body) ? body : {};
      if (typeof machine !== "string" || !MACHINE.test(machine))
        return { status: 400, body: { error: 'machine must be "server" or a runner id.' } };
      const allowed = machine === SERVER_MACHINE ? SERVER_CATEGORIES : RUNNER_CATEGORIES;
      const chosen =
        categories === undefined ? enabledCategories(await settings(), machine) : categories;
      if (!Array.isArray(chosen) || !chosen.every((c) => (allowed as unknown[]).includes(c)))
        return {
          status: 400,
          body: { error: `categories for ${machine} must list ${allowed.join(" or ")}.` },
        };
      if (machine !== SERVER_MACHINE && chosen.length > 0) return previewRunner(machine, null);
      return { status: 200, body: await preview(machine, [...new Set(chosen)]) };
    },
    async readPreview(id: string): Promise<CleanupReply> {
      const row = await store.run((q) => readStorageCleanupPreviewSteps(q, id));
      if (!row) return { status: 404, body: { error: "No such cleanup preview." } };
      const { id: found, machine, pending, expiresAt, items, kept } = row;
      return { status: 200, body: { id: found, machine, pending, expiresAt, items, kept } };
    },
    async run(body: unknown, actor: string): Promise<CleanupReply> {
      const previewId = isRecord(body) ? body.previewId : undefined;
      if (typeof previewId !== "string")
        return { status: 400, body: { error: "previewId is required." } };
      return run(previewId, actor);
    },
    async history(): Promise<CleanupReply> {
      return { status: 200, body: await store.run((q) => listStorageCleanupsSteps(q, 200)) };
    },
    async tick(): Promise<void> {
      const rules = await settings();
      const at = now();
      await store.transaction((q) =>
        expireStorageCleanupsSteps(q, {
          exceptMachine: SERVER_MACHINE,
          startedBefore: at - COMMAND_MS,
          now: at,
          error: "The runner did not answer.",
        }),
      );
      if (!rules.schedule.enabled) return;
      const due = lastScheduledAt(rules.schedule.timeUtc, at);
      for (const machine of rules.schedule.machines) {
        const categories = enabledCategories(rules, machine);
        if (categories.length === 0) continue;
        const last = await store.run((q) => lastStorageCleanupStartedSteps(q, machine, "schedule"));
        if (last !== null && last >= due) continue;
        if (machine !== SERVER_MACHINE) {
          await previewRunner(machine, "schedule");
          continue;
        }
        const { id } = await preview(machine, categories);
        await run(id, "schedule");
      }
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      if (new URL(request.url).pathname !== "/v1/storage-cleanup") return null;
      if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
      const body = await readWebhookBody(request, 4 * 1024 * 1024);
      if (body instanceof Response) return body;
      const parsed = RunnerStorageCleanupResultSchema.safeParse(
        (() => {
          try {
            return JSON.parse(body.toString("utf8"));
          } catch {
            return null;
          }
        })(),
      );
      if (!parsed.success)
        return Response.json({ error: "Storage cleanup result was rejected." }, { status: 400 });
      const result = parsed.data;
      const at = now();
      const category = "worker_logs" as const;
      if (result.mode === "preview") {
        const answer = {
          id: result.cleanupId,
          machine: runnerId,
          items: result.items.map((item) => ({ category, ...item })),
          kept: result.kept.map((group) => ({ category, ...group })),
          expiresAt: at + PREVIEW_MS,
        };
        const row = await store.transaction((q) => answerStorageCleanupPreviewSteps(q, answer, at));
        if (row?.actor === "schedule")
          await run(row.id, "schedule").catch((error: unknown) =>
            journalCaught(error, "storage-cleanup.schedule.runner", null),
          );
        return Response.json({ duplicate: row === undefined });
      }
      const finished = await store.transaction((q) =>
        finishStorageCleanupSteps(
          q,
          result.cleanupId,
          {
            finishedAt: at,
            deleted: result.deleted.map((item) => ({ category, ...item })),
            skipped: result.skipped.map((item) => ({ category, ...item })),
            freedBytes: result.freedBytes,
            error: null,
          },
          runnerId,
        ),
      );
      return Response.json({ duplicate: !finished });
    },
    async sweep(): Promise<void> {
      const rules = await settings();
      const entries = await temporary(
        listTemporary(),
        rules.categories.temporary.olderThanHours,
        now(),
      );
      const items = entries.filter((entry): entry is CleanupItem => "bytes" in entry);
      if (items.length > 0) await execute(SERVER_MACHINE, ["temporary"], items, "startup");
    },
  };
}
