import type { Database } from "bun:sqlite";
import {
  workspaceMemberUsable,
  closeRetro,
  collectingRetroIds,
  getRetro,
  immediate,
  latestPublishedRetro,
  latestRetro,
  listRetroItems,
  listRetroSettingsRevisions,
  listWorkspaceMembers,
  listWorkspaceRepositoryNames,
  newRetroId,
  readRetroArtifact,
  recordRetroGeneration,
  recordRetroOccurrence,
  recordRetroScheduleRun,
  recordRetroScheduleState,
  retroHasUnfinishedDispatch,
  retroOccurrence,
  retroScheduleRuntime,
  retroSettingsWorkspaces,
  retroWatermarks,
  type Retro,
  type RetroOrigin,
  type RetroState,
} from "../db";
import { journalCaught } from "../journal";
import type { AgentModelCatalog } from "../runner-models";
import { isWorkspaceAdmin } from "../workspace";
import { collectRetroDigest, type RetroDigest } from "./digest";
import { retroGenerationView, type RetroGenerationView } from "./dispatch";
import { retroNeedsGeneration } from "./result";
import {
  freezeRetroRun,
  proposedRetroSettings,
  RETRO_WEEKDAYS,
  retroRunRepositories,
  validRetroTimeZone,
  type RetroAgentProfile,
  type RetroSchedule,
  type RetroWeekday,
} from "./settings";

export const RETRO_SCHEDULE_JOB = "retro.schedule";
export const RETRO_SCHEDULE_TICK_MS = 60_000;

const DAY = 86_400_000;
const FIRST_RETRO_WINDOW_MS = 7 * DAY;
const OPEN_STATES: readonly RetroState[] = ["collecting", "queued", "generating", "failed"];

export type RetroLocalAdjustment = "exact" | "skipped_forward" | "repeated_first";

export type RetroOccurrence = {
  at: number;
  timeZone: string;
  weekday: RetroWeekday;
  localDate: string;
  localTime: string;
  utcOffsetMinutes: number;
  local: string;
  adjustment: RetroLocalAdjustment;
};

function zonedParts(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetAt(at: number, timeZone: string): number {
  const local = zonedParts(at, timeZone);
  const wall = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return wall - Math.floor(at / 1000) * 1000;
}

const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, "0");

function describe(at: number, timeZone: string, adjustment: RetroLocalAdjustment): RetroOccurrence {
  const local = zonedParts(at, timeZone);
  const offset = Math.round(offsetAt(at, timeZone) / 60_000);
  const localDate = `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`;
  const localTime = `${pad(local.hour)}:${pad(local.minute)}`;
  const weekday =
    RETRO_WEEKDAYS[
      (new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay() + 6) % 7
    ]!;
  const sign = offset < 0 ? "-" : "+";
  return {
    at,
    timeZone,
    weekday,
    localDate,
    localTime,
    utcOffsetMinutes: offset,
    local: `${localDate}T${localTime}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`,
    adjustment,
  };
}

export function resolveRetroLocalTime(
  date: { year: number; month: number; day: number },
  time: string,
  timeZone: string,
): RetroOccurrence {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const matches = [...new Set([wall - before, wall - after])]
    .filter((at) => wall === at + offsetAt(at, timeZone))
    .sort((a, b) => a - b);
  if (matches.length === 0) return describe(wall - before, timeZone, "skipped_forward");
  return describe(matches[0]!, timeZone, matches.length > 1 ? "repeated_first" : "exact");
}

export function nextRetroOccurrenceDetail(
  schedule: RetroSchedule,
  after: number,
): RetroOccurrence | null {
  if (schedule.cadence === "paused") return null;
  const today = zonedParts(after, schedule.timeZone);
  for (let days = 0; days <= 8; days++) {
    const noon = new Date(Date.UTC(today.year, today.month - 1, today.day + days, 12));
    if (RETRO_WEEKDAYS[(noon.getUTCDay() + 6) % 7] !== schedule.weekday) continue;
    const occurrence = resolveRetroLocalTime(
      { year: noon.getUTCFullYear(), month: noon.getUTCMonth() + 1, day: noon.getUTCDate() },
      schedule.time,
      schedule.timeZone,
    );
    if (occurrence.at > after) return occurrence;
  }
  return null;
}

export function nextRetroOccurrence(schedule: RetroSchedule, after: number): number | null {
  return nextRetroOccurrenceDetail(schedule, after)?.at ?? null;
}

export function dueRetroOccurrence(
  schedule: RetroSchedule,
  base: number,
  now: number,
): { due: RetroOccurrence | null; next: RetroOccurrence | null } {
  const first = nextRetroOccurrenceDetail(schedule, base);
  if (first === null || first.at > now) return { due: null, next: first };
  let due = nextRetroOccurrenceDetail(schedule, Math.max(base, now - 8 * DAY)) ?? first;
  for (;;) {
    const next = nextRetroOccurrenceDetail(schedule, due.at);
    if (next === null || next.at > now) return { due, next };
    due = next;
  }
}

type SchedulePlan =
  | { saved: false; schedule: RetroSchedule }
  | {
      saved: true;
      revision: number;
      schedule: RetroSchedule;
      repositories: string[];
      agent: RetroAgentProfile["agent"];
      createdBy: string;
      active: boolean;
      base: number;
      due: RetroOccurrence | null;
      next: RetroOccurrence | null;
    };

function schedulePlan(db: Database, workspaceId: string, now: number): SchedulePlan {
  const rows = listRetroSettingsRevisions(db, workspaceId);
  const latest = rows[0];
  if (latest === undefined) return { saved: false, schedule: proposedRetroSettings([]).schedule };
  const read = (stored: Record<string, unknown>) => stored as RetroSchedule;
  const key = (schedule: RetroSchedule) =>
    JSON.stringify([schedule.cadence, schedule.weekday, schedule.time, schedule.timeZone]);
  const schedule = read(latest.schedule);
  let since = latest.createdAt;
  for (const row of rows) {
    if (key(read(row.schedule)) !== key(schedule)) break;
    since = row.createdAt;
  }
  const active = schedule.cadence === "weekly" && validRetroTimeZone(schedule.timeZone);
  const base = Math.max(retroScheduleRuntime(db, workspaceId)?.lastOccurrenceAt ?? since, since);
  const { due, next } = active
    ? dueRetroOccurrence(schedule, base, now)
    : { due: null, next: null };
  return {
    saved: true,
    revision: latest.revision,
    schedule,
    repositories: latest.repositories,
    agent: (latest.agentProfile as RetroAgentProfile).agent,
    createdBy: latest.createdBy,
    active,
    base,
    due,
    next,
  };
}

function openRetro(db: Database, workspaceId: string): Retro | null {
  return latestRetro(db, workspaceId, OPEN_STATES);
}

function retriesSpent(db: Database, retro: Retro): boolean {
  if (retro.state !== "failed") return false;
  return (
    !retroHasUnfinishedDispatch(db, retro.id) && retroGenerationView(db, retro.id)?.retry === null
  );
}

function latestPublished(db: Database, workspaceId: string): Retro | null {
  return latestPublishedRetro(db, workspaceId);
}

export type RetroCatalogSource = (principal: {
  workspaceId: string;
  userId: string;
}) => readonly AgentModelCatalog[] | null;

export type RetroRequest =
  | { ok: true; retro: Retro; created: boolean }
  | {
      ok: false;
      reason:
        | "no_settings"
        | "no_accessible_repository"
        | "catalog_unavailable"
        | "unsupported"
        | "clock_behind"
        | "busy"
        | "stale";
      message: string;
    };

export const RETRO_SCHEDULE_STATES = ["waiting", "generating", "ready", "failed", "empty"] as const;
export type RetroScheduleState = (typeof RETRO_SCHEDULE_STATES)[number];

export type RetroScheduleStatus = {
  workspaceId: string;
  saved: boolean;
  settingsRevision: number;
  schedule: RetroSchedule;
  state: RetroScheduleState;
  reason: string | null;
  nextRun: (RetroOccurrence & { due: boolean }) | null;
  retry: { at: number } | null;
  blocked: { reason: string; since: number | null } | null;
  lastSuccess: {
    retroId: string;
    cutoff: number;
    windowStart: number;
    publishedAt: number | null;
    empty: boolean;
  } | null;
  current: {
    retroId: string;
    origin: RetroOrigin;
    state: RetroState;
    windowStart: number;
    windowEnd: number;
    occurrence: StoredOccurrence | null;
    error: string | null;
    generation: RetroGenerationView | null;
  } | null;
};

type StoredOccurrence = {
  origin: RetroOrigin;
  occurrenceAt: number;
  timeZone: string;
  localDate: string;
  localTime: string;
  utcOffsetMinutes: number;
  adjustment: RetroLocalAdjustment;
  requestedBy: string | null;
};

function storedOccurrence(db: Database, retroId: string): StoredOccurrence | null {
  return retroOccurrence(db, retroId) as StoredOccurrence | null;
}

export function createRetroScheduler(options: {
  db: Database;
  artifactRoot: string;
  catalogs: RetroCatalogSource;
  now?: () => number;
  secrets?: () => readonly string[];
}) {
  const { db, artifactRoot } = options;
  const now = options.now ?? Date.now;

  function catalogsFor(
    workspaceId: string,
    agent: string,
    author: string,
  ): readonly AgentModelCatalog[] | null {
    const admins = listWorkspaceMembers(db, workspaceId)
      .filter((member) => workspaceMemberUsable(member) && isWorkspaceAdmin(member.role))
      .map((member) => member.id);
    let fallback: readonly AgentModelCatalog[] | null = null;
    for (const userId of new Set([author, ...admins])) {
      let catalogs: readonly AgentModelCatalog[] | null;
      try {
        catalogs = options.catalogs({ workspaceId, userId });
      } catch (error) {
        journalCaught(error, "retros.schedule.catalogs", null);
        continue;
      }
      if (catalogs === null) continue;
      if (catalogs.some((entry) => entry.agent === agent)) return catalogs;
      fallback ??= catalogs;
    }
    return fallback;
  }

  function windowStart(workspaceId: string, repositories: readonly string[], end: number): number {
    const marks = retroWatermarks(db, workspaceId);
    const cursor = (repository: string) =>
      marks.find((mark) => mark.repository.toLowerCase() === repository.toLowerCase())?.cursor ??
      end - FIRST_RETRO_WINDOW_MS;
    return Math.min(...repositories.map(cursor));
  }

  function claim(input: {
    workspaceId: string;
    origin: RetroOrigin;
    occurrence: RetroOccurrence;
    requestedBy: string | null;
  }): RetroRequest {
    const at = now();
    return immediate(db, (): RetroRequest => {
      const plan = schedulePlan(db, input.workspaceId, at);
      if (!plan.saved)
        return { ok: false, reason: "no_settings", message: "Save retro settings first." };
      if (input.origin === "scheduled" && plan.due?.at !== input.occurrence.at)
        return { ok: false, reason: "stale", message: "Another tick claimed this occurrence." };
      const open = openRetro(db, input.workspaceId);
      if (open !== null) {
        if (!retriesSpent(db, open)) {
          if (input.origin === "manual") return { ok: true, retro: open, created: false };
          return {
            ok: false,
            reason: "busy",
            message: `Waiting for the open retro ${open.id} (${open.state}) to finish.`,
          };
        }
        const reason = "Retries are spent. A new retro collects the same activity again.";
        closeRetro(db, { retroId: open.id, state: "abandoned", error: reason, now: at });
        recordRetroGeneration(db, {
          retroId: open.id,
          diagnostic: "failed",
          detail: reason,
          now: at,
        });
      }
      const accessible = listWorkspaceRepositoryNames(db, input.workspaceId);
      const repositories = retroRunRepositories(plan.repositories, accessible);
      if (repositories.length === 0)
        return {
          ok: false,
          reason: "no_accessible_repository",
          message: "None of the selected repositories is accessible.",
        };
      const end = input.occurrence.at;
      const start = windowStart(input.workspaceId, repositories, end);
      const consume = (retroId: string) => {
        const covered =
          input.origin === "scheduled"
            ? input.occurrence
            : plan.active
              ? dueRetroOccurrence(plan.schedule, plan.base, end).due
              : null;
        if (covered !== null)
          recordRetroScheduleRun(db, {
            workspaceId: input.workspaceId,
            occurrenceAt: covered.at,
            retroId,
            nextDueAt: nextRetroOccurrence(plan.schedule, Math.max(covered.at, at)),
            now: at,
          });
      };
      if (end <= start) {
        if (input.origin === "manual")
          return {
            ok: false,
            reason: "clock_behind",
            message: "The clock is behind the last retro cutoff. Try again later.",
          };
        const last = latestPublished(db, input.workspaceId);
        if (last !== null) consume(last.id);
        return {
          ok: false,
          reason: "stale",
          message: "A published retro already covers this occurrence.",
        };
      }
      const frozen = freezeRetroRun(db, {
        id: newRetroId(at),
        workspaceId: input.workspaceId,
        windowStart: start,
        windowEnd: end,
        origin: input.origin,
        ...(input.origin === "scheduled" ? { scheduledFor: end } : {}),
        catalogs: catalogsFor(input.workspaceId, plan.agent, plan.createdBy),
        accessibleRepositories: accessible,
        now: at,
      });
      if (!frozen.ok) return frozen;
      if (frozen.created)
        recordRetroOccurrence(db, {
          retroId: frozen.retro.id,
          workspaceId: input.workspaceId,
          origin: input.origin,
          occurrenceAt: input.occurrence.at,
          windowStart: start,
          windowEnd: end,
          timeZone: input.occurrence.timeZone,
          localDate: input.occurrence.localDate,
          localTime: input.occurrence.localTime,
          utcOffsetMinutes: input.occurrence.utcOffsetMinutes,
          localAdjustment: input.occurrence.adjustment,
          settingsRevision: frozen.retro.settingsRevision,
          requestedBy: input.requestedBy,
          createdAt: at,
        });
      consume(frozen.retro.id);
      return { ok: true, retro: frozen.retro, created: frozen.created };
    });
  }

  function collect(retro: Retro) {
    try {
      const collected = collectRetroDigest(db, {
        retroId: retro.id,
        artifactRoot,
        now: retro.createdAt,
        ...(options.secrets ? { secrets: options.secrets() } : {}),
      });
      if (!collected.ok && collected.reason === "busy")
        journalCaught(
          new Error(
            `Retro ${retro.id} waits for ${collected.busy.map((b) => b.retroId).join(", ")}`,
          ),
          "retros.schedule.collect",
          null,
          "another retro still holds a repository window",
        );
    } catch (error) {
      journalCaught(error, "retros.schedule.collect", null);
      if (getRetro(db, retro.id)?.state !== "collecting") return;
      const reason = `Evidence collection failed: ${error instanceof Error ? error.message : String(error)}`;
      closeRetro(db, {
        retroId: retro.id,
        state: "abandoned",
        error: reason.slice(0, 2000),
        now: now(),
      });
      recordRetroGeneration(db, {
        retroId: retro.id,
        diagnostic: "failed",
        detail: reason.slice(0, 2000),
        now: now(),
      });
    }
  }

  function advance(workspaceId: string) {
    for (const id of collectingRetroIds(db, workspaceId)) collect(getRetro(db, id)!);
    const plan = schedulePlan(db, workspaceId, now());
    if (!plan.saved) return;
    const state = (nextDueAt: number | null, blockedReason: string | null) =>
      recordRetroScheduleState(db, { workspaceId, nextDueAt, blockedReason, now: now() });
    if (plan.due === null) return state(plan.next?.at ?? null, null);
    const claimed = claim({
      workspaceId,
      origin: "scheduled",
      occurrence: plan.due,
      requestedBy: null,
    });
    if (claimed.ok) {
      if (claimed.created) collect(claimed.retro);
      const after = schedulePlan(db, workspaceId, now());
      return state(after.saved ? ((after.due ?? after.next)?.at ?? null) : null, null);
    }
    if (claimed.reason === "stale") {
      const after = schedulePlan(db, workspaceId, now());
      return state(after.saved ? ((after.due ?? after.next)?.at ?? null) : null, null);
    }
    state(plan.due.at, claimed.message);
  }

  function status(workspaceId: string): RetroScheduleStatus {
    const at = now();
    const plan = schedulePlan(db, workspaceId, at);
    const runtime = retroScheduleRuntime(db, workspaceId);
    const published = latestPublished(db, workspaceId);
    const emptyPublished = (retro: Retro) => {
      if (listRetroItems(db, retro.id).length > 0) return false;
      const digest = readRetroArtifact(db, artifactRoot, retro.id, "digest");
      if (!digest.ok) return false;
      return !retroNeedsGeneration(
        JSON.parse(new TextDecoder().decode(digest.bytes)) as RetroDigest,
      );
    };
    const lastSuccess =
      published === null
        ? null
        : {
            retroId: published.id,
            cutoff: published.windowEnd,
            windowStart: published.windowStart,
            publishedAt: published.publishedAt,
            empty: emptyPublished(published),
          };
    const open = openRetro(db, workspaceId);
    const latest = latestRetro(db, workspaceId);
    const closedFailure =
      latest !== null &&
      (latest.state === "abandoned" || latest.state === "coverage_failed") &&
      (published === null || latest.createdAt > published.createdAt)
        ? latest
        : null;
    const shown = open ?? closedFailure;
    const generation = shown === null ? null : retroGenerationView(db, shown.id);
    const nextRun =
      plan.saved && plan.active
        ? plan.due !== null
          ? { ...plan.due, due: true }
          : plan.next && { ...plan.next, due: false }
        : null;
    const blocked =
      plan.saved && plan.due !== null && runtime?.blockedReason
        ? { reason: runtime.blockedReason, since: runtime.blockedSince }
        : null;
    let state: RetroScheduleState;
    let reason: string | null = null;
    let retry: { at: number } | null = null;
    if (open?.state === "collecting") {
      state = "waiting";
      reason = "Collecting session evidence for this window.";
    } else if (open !== null) {
      const view = generation!;
      state =
        view.state === "generating" ? "generating" : view.state === "failed" ? "failed" : "waiting";
      reason = view.state === "failed" ? (view.error ?? view.detail) : (view.detail ?? "Queued.");
      retry = view.retry;
    } else if (closedFailure !== null) {
      state = "failed";
      reason = closedFailure.error;
      retry = nextRun && { at: nextRun.at };
    } else if (blocked !== null) {
      state = "waiting";
      reason = blocked.reason;
    } else if (lastSuccess !== null) {
      state = lastSuccess.empty ? "empty" : "ready";
    } else {
      state = "waiting";
      reason = !plan.saved
        ? "Save retro settings to start weekly retros."
        : plan.active
          ? "The first retro runs at the next scheduled time."
          : "Weekly retros are paused. Run a retro to start one now.";
    }
    return {
      workspaceId,
      saved: plan.saved,
      settingsRevision: plan.saved ? plan.revision : 0,
      schedule: plan.schedule,
      state,
      reason,
      nextRun,
      retry,
      blocked,
      lastSuccess,
      current:
        shown === null
          ? null
          : {
              retroId: shown.id,
              origin: shown.origin,
              state: shown.state,
              windowStart: shown.windowStart,
              windowEnd: shown.windowEnd,
              occurrence: storedOccurrence(db, shown.id),
              error: shown.error,
              generation,
            },
    };
  }

  return {
    tick() {
      for (const workspaceId of retroSettingsWorkspaces(db)) {
        try {
          advance(workspaceId);
        } catch (error) {
          journalCaught(error, "retros.schedule.tick", null);
        }
      }
    },
    request(workspaceId: string, userId: string): RetroRequest {
      const plan = schedulePlan(db, workspaceId, now());
      const timeZone = validRetroTimeZone(plan.schedule.timeZone) ? plan.schedule.timeZone : "UTC";
      const claimed = claim({
        workspaceId,
        origin: "manual",
        occurrence: describe(now(), timeZone, "exact"),
        requestedBy: userId,
      });
      if (claimed.ok && claimed.retro.state === "collecting") collect(claimed.retro);
      return claimed.ok ? { ...claimed, retro: getRetro(db, claimed.retro.id)! } : claimed;
    },
    status,
  };
}

export type RetroScheduler = ReturnType<typeof createRetroScheduler>;
