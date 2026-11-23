import { lstatSync, readdirSync, rmSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import type { PawsPaths } from "../config";
import {
  closeoutLogCandidates,
  finishStorageCleanupSteps,
  lastStorageCleanupStartedSteps,
  listStorageCleanupsSteps,
  readSetting,
  removeCloseoutOutputs,
  saveStorageCleanupPreviewSteps,
  startStorageCleanupSteps,
  takeStorageCleanupPreviewSteps,
  updateSetting,
  workItemStatesSteps,
  type Db,
  type ExpiredCloseoutOutput,
} from "../db";
import { journalCaught } from "../journal";
import { SERVER_MACHINE } from "../storage-usage";

export const CLEANUP_CATEGORIES = ["temporary", "closeout_logs"] as const;
export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];
export const STORAGE_CLEANUP_KEY = "storage.cleanup";
export const STORAGE_CLEANUP_JOB = "storage.cleanup.schedule";
export const STORAGE_CLEANUP_TICK_MS = 5 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PREVIEW_MS = 15 * 60_000;
const OWNERLESS_MS = 7 * DAY;
const LIMIT = 10_000;
const ACTIVE = new Set(["running", "queued", "paused", "recovering", "verifying"]);
const OWNED = /^paws-[a-z]+-([0-9A-HJKMNP-TV-Z]{26})-/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MACHINE = /^[A-Za-z0-9._:-]{1,128}$/;

export type CleanupSettings = {
  schedule: { enabled: boolean; timeUtc: string; machines: string[] };
  categories: {
    temporary: { enabled: boolean; olderThanHours: number };
    closeout_logs: { enabled: boolean };
  };
};

export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
  schedule: { enabled: false, timeUtc: "03:00", machines: [] },
  categories: {
    temporary: { enabled: true, olderThanHours: 24 },
    closeout_logs: { enabled: true },
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
  return {
    schedule: {
      enabled: schedule.enabled,
      timeUtc: schedule.timeUtc,
      machines: [...new Set(machines as string[])],
    },
    categories: {
      temporary: { enabled: temporary.enabled, olderThanHours: hours },
      closeout_logs: { enabled: logs.enabled },
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

  const run = async (previewId: string, actor: string): Promise<CleanupReply> => {
    const row = await store.transaction((q) => takeStorageCleanupPreviewSteps(q, previewId));
    if (!row) return { status: 404, body: { error: "No such cleanup preview." } };
    if (row.expiresAt <= now())
      return { status: 410, body: { error: "This preview expired. Preview again." } };
    const body = await execute(
      row.machine,
      row.categories as CleanupCategory[],
      row.items as CleanupItem[],
      actor,
    );
    return { status: 200, body };
  };

  const enabledCategories = (rules: CleanupSettings) =>
    CLEANUP_CATEGORIES.filter((category) => rules.categories[category].enabled);

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
      if (machine !== SERVER_MACHINE)
        return { status: 400, body: { error: 'Only the "server" machine can be cleaned up.' } };
      const chosen = categories === undefined ? enabledCategories(await settings()) : categories;
      if (
        !Array.isArray(chosen) ||
        !chosen.every((c) => (CLEANUP_CATEGORIES as readonly unknown[]).includes(c))
      )
        return {
          status: 400,
          body: { error: `categories must list ${CLEANUP_CATEGORIES.join(" or ")}.` },
        };
      return { status: 200, body: await preview(machine, [...new Set(chosen)]) };
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
      const categories = enabledCategories(rules);
      if (!rules.schedule.enabled || categories.length === 0) return;
      const due = lastScheduledAt(rules.schedule.timeUtc, now());
      for (const machine of rules.schedule.machines) {
        if (machine !== SERVER_MACHINE) continue;
        const last = await store.run((q) => lastStorageCleanupStartedSteps(q, machine, "schedule"));
        if (last !== null && last >= due) continue;
        const { id } = await preview(machine, categories);
        await run(id, "schedule");
      }
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
