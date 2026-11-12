import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failRetroAttempt,
  getRetro,
  listRetros,
  retroScheduleRuntime,
  retroWatermarks,
  saveRetroSettingsRevision,
  startRetroAttempt,
  syncSteps,
  type Db,
} from "../db";
import type { AgentModelCatalog } from "../runner-models";
import type { WorkspacePrincipal } from "../workspace";
import { seedActivityPg, seedWorkspacePg, sign } from "./dispatch.fixtures";
import {
  createFakeRetroCatalog,
  createRetroDispatcher,
  createRetroScheduleHttp,
  createRetroScheduler,
  nextRetroOccurrence,
  resolveRetroLocalTime,
  RETRO_RUNS_PATH,
  RETRO_SCHEDULE_PATH,
  type RetroScheduleStatus,
} from "./index";
import { FIXTURE_REPO } from "./result.fixtures";
import { seed, withoutForeignKeys } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const BERLIN = "Europe/Berlin";
const HOUR = 3_600_000;
const SAVED = Date.UTC(2026, 10, 1, 12);
const MONDAY = Date.UTC(2026, 10, 2, 8);
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const CATALOGS: AgentModelCatalog[] = [
  {
    agent: "codex",
    updatedAt: 1,
    efforts: [],
    defaultModel: "gpt-x",
    models: [{ id: "gpt-x", name: "gpt-x", longContext: false, efforts: [], defaultEffort: null }],
  },
];

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function schedule(input: { cadence?: "weekly" | "paused"; timeZone?: string } = {}) {
  return {
    cadence: input.cadence ?? "weekly",
    weekday: "monday",
    time: "09:00",
    timeZone: input.timeZone ?? BERLIN,
  };
}

async function save(
  db: Db,
  now: number,
  options: { paused?: boolean; retries?: number; repositories?: string[] } = {},
) {
  return await saveRetroSettingsRevision(db, {
    workspaceId: "ws",
    prompt: "Review {{period}} in {{repositories}}.\n\n{{digest}}",
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    repositories: options.repositories ?? [FIXTURE_REPO],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: options.retries ?? 1 },
    schedule: schedule({ cadence: options.paused ? "paused" : "weekly" }),
    createdBy: "admin",
    now,
  });
}

async function world(options: { activity?: boolean; retries?: number; settings?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-schedule-"));
  roots.push(root);
  const { db, close } = await tempStore();
  closes.push(close);
  await seedWorkspacePg(db);
  if (options.activity !== false) await seedActivityPg(db, "PAS-817", 2);
  if (options.settings !== false) await save(db, SAVED, { retries: options.retries ?? 1 });
  const clock = { now: SAVED };
  const catalog = { value: CATALOGS as AgentModelCatalog[] | null };
  const open = () =>
    createRetroScheduler({
      store: db,
      artifactRoot: root,
      catalogs: () => syncSteps(() => catalog.value),
      now: () => clock.now,
    });
  const dispatcher = () =>
    createRetroDispatcher({ store: db, artifactRoot: root, sign, now: () => clock.now });
  return { db, root, clock, catalog, open, dispatcher };
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

describe("occurrences in an IANA zone", () => {
  test("a skipped local time runs at the first instant after the gap", () => {
    const spring = resolveRetroLocalTime({ year: 2027, month: 3, day: 28 }, "02:30", BERLIN);
    expect(iso(spring.at)).toBe("2027-03-28T01:30:00.000Z");
    expect(spring).toMatchObject({
      adjustment: "skipped_forward",
      localTime: "03:30",
      local: "2027-03-28T03:30+02:00",
    });
  });

  test("a repeated local time runs once, at its earlier instant", () => {
    const fall = resolveRetroLocalTime({ year: 2026, month: 10, day: 25 }, "02:30", BERLIN);
    expect(iso(fall.at)).toBe("2026-10-25T00:30:00.000Z");
    expect(fall).toMatchObject({ adjustment: "repeated_first", local: "2026-10-25T02:30+02:00" });
    const sunday = { cadence: "weekly" as const, weekday: "sunday" as const, time: "02:30" };
    expect(iso(nextRetroOccurrence({ ...sunday, timeZone: BERLIN }, fall.at))).toBe(
      "2026-11-01T01:30:00.000Z",
    );
  });

  test("the wall time stays 09:00 across a daylight-saving change", () => {
    const weekly = { cadence: "weekly" as const, weekday: "monday" as const, time: "09:00" };
    const before = nextRetroOccurrence({ ...weekly, timeZone: BERLIN }, Date.UTC(2026, 9, 18));
    expect(iso(before)).toBe("2026-10-19T07:00:00.000Z");
    expect(iso(nextRetroOccurrence({ ...weekly, timeZone: BERLIN }, before!))).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(
      resolveRetroLocalTime({ year: 2026, month: 11, day: 9 }, "09:00", "America/New_York"),
    ).toMatchObject({ adjustment: "exact", local: "2026-11-09T09:00-05:00", weekday: "monday" });
  });
});

describe("weekly schedule", () => {
  test("downtime collapses missed weeks into one catch-up window; duplicate ticks and a second process add nothing", async () => {
    const { db, clock, open } = await world();
    const scheduler = open();
    clock.now = MONDAY - 1;
    await scheduler.tick();
    expect(await listRetros(db, "ws")).toHaveLength(0);
    expect((await retroScheduleRuntime(db, "ws"))?.nextDueAt).toBe(MONDAY);

    clock.now = MONDAY + 3 * WEEK + HOUR;
    await scheduler.tick();
    await open().tick();
    await scheduler.tick();
    const retros = await listRetros(db, "ws");
    expect(retros).toHaveLength(1);
    expect(retros[0]).toMatchObject({
      origin: "scheduled",
      windowStart: MONDAY + 2 * WEEK,
      windowEnd: MONDAY + 3 * WEEK,
      scheduledFor: MONDAY + 3 * WEEK,
      state: "queued",
    });
    expect(await retroScheduleRuntime(db, "ws")).toMatchObject({
      lastOccurrenceAt: MONDAY + 3 * WEEK,
      nextDueAt: MONDAY + 4 * WEEK,
      blockedReason: null,
    });
    const occurrence = await db.run((q) =>
      q.all(
        q.orm
          .select({
            origin: q.t.retroOccurrence.origin,
            localDate: q.t.retroOccurrence.localDate,
            localTime: q.t.retroOccurrence.localTime,
            timeZone: q.t.retroOccurrence.timeZone,
            utcOffsetMinutes: q.t.retroOccurrence.utcOffsetMinutes,
          })
          .from(q.t.retroOccurrence),
      ),
    );
    expect(occurrence).toEqual([
      {
        origin: "scheduled",
        localDate: "2026-11-23",
        localTime: "09:00",
        timeZone: BERLIN,
        utcOffsetMinutes: 60,
      },
    ]);

    const restarted = await open().status("ws");
    expect(restarted.nextRun).toMatchObject({ local: "2026-11-30T09:00+01:00", due: false });
    expect(restarted.state).toBe("waiting");
  });

  test("a clock rollback after a claim creates no job and leaves the runtime alone", async () => {
    const { db, clock, open } = await world();
    const scheduler = open();
    clock.now = MONDAY + HOUR;
    await scheduler.tick();
    const before = await retroScheduleRuntime(db, "ws");
    clock.now = MONDAY - 2 * WEEK;
    await scheduler.tick();
    expect(await listRetros(db, "ws")).toHaveLength(1);
    expect((await retroScheduleRuntime(db, "ws"))?.lastOccurrenceAt).toBe(before!.lastOccurrenceAt);
  });

  test("an empty period publishes without an agent and moves the watermark for the next window", async () => {
    const { db, clock, open, dispatcher } = await world({ activity: false });
    const scheduler = open();
    clock.now = MONDAY + 60_000;
    await scheduler.tick();
    await dispatcher().tick();
    const status = await scheduler.status("ws");
    expect(status.state).toBe("empty");
    expect(status.lastSuccess).toMatchObject({ cutoff: MONDAY, empty: true });
    expect((await retroWatermarks(db, "ws"))[0]!.cursor).toBe(MONDAY);
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.retroDispatch)))).toEqual([]);

    clock.now = MONDAY + WEEK + 60_000;
    await scheduler.tick();
    const next = (await listRetros(db, "ws"))[0]!;
    expect([next.windowStart, next.windowEnd]).toEqual([MONDAY, MONDAY + WEEK]);
  });

  test("pause stops future occurrences but not the open retro; resume does not catch up the pause", async () => {
    const { db, clock, open } = await world();
    const scheduler = open();
    clock.now = MONDAY + HOUR;
    await scheduler.tick();
    const running = (await listRetros(db, "ws"))[0]!;
    await save(db, MONDAY + 2 * HOUR, { paused: true });
    clock.now = MONDAY + 3 * WEEK;
    await scheduler.tick();
    expect((await listRetros(db, "ws")).map((retro) => retro.id)).toEqual([running.id]);
    expect((await getRetro(db, running.id))!.state).toBe("queued");
    const paused = await scheduler.status("ws");
    expect(paused.nextRun).toBeNull();
    expect((await retroScheduleRuntime(db, "ws"))?.nextDueAt).toBeNull();

    const resumedAt = Date.UTC(2026, 11, 1, 10);
    await save(db, resumedAt);
    clock.now = resumedAt + HOUR;
    await scheduler.tick();
    expect(await listRetros(db, "ws")).toHaveLength(1);
    expect((await scheduler.status("ws")).nextRun).toMatchObject({
      local: "2026-12-07T09:00+01:00",
      due: false,
    });
  });

  test("an unavailable profile holds the occurrence with a reason until a catalog reports it", async () => {
    const { db, clock, open, catalog } = await world();
    const scheduler = open();
    catalog.value = null;
    clock.now = MONDAY + HOUR;
    await scheduler.tick();
    expect(await listRetros(db, "ws")).toHaveLength(0);
    const held = await scheduler.status("ws");
    expect(held.state).toBe("waiting");
    expect(held.blocked?.reason).toContain("codex");
    expect(held.nextRun).toMatchObject({ at: MONDAY, due: true });

    catalog.value = CATALOGS;
    await scheduler.tick();
    expect(await listRetros(db, "ws")).toHaveLength(1);
    expect((await scheduler.status("ws")).blocked).toBeNull();
  });
});

describe("manual runs share the scheduled window", () => {
  test("a manual run and a due occurrence create one retro whichever comes first", async () => {
    const first = await world();
    first.clock.now = MONDAY + HOUR;
    const manual = await first.open().request("ws", "member");
    expect(manual).toMatchObject({ ok: true, created: true });
    await first.open().tick();
    expect(await listRetros(first.db, "ws")).toHaveLength(1);
    expect((await retroScheduleRuntime(first.db, "ws"))?.lastOccurrenceAt).toBe(MONDAY);

    const second = await world();
    second.clock.now = MONDAY + HOUR;
    const scheduler = second.open();
    await scheduler.tick();
    const scheduled = (await listRetros(second.db, "ws"))[0]!;
    const again = await second.open().request("ws", "admin");
    expect(again).toMatchObject({ ok: true, created: false, retro: { id: scheduled.id } });
  });

  test("a scheduled occurrence waits while a manual retro is open, then covers only what came after", async () => {
    const { db, clock, open, dispatcher } = await world({ activity: false });
    const scheduler = open();
    clock.now = MONDAY - HOUR;
    const manual = await scheduler.request("ws", "member");
    expect(manual.ok).toBe(true);
    clock.now = MONDAY + HOUR;
    await scheduler.tick();
    expect(await listRetros(db, "ws")).toHaveLength(1);
    expect((await scheduler.status("ws")).state).toBe("waiting");

    await dispatcher().tick();
    await scheduler.tick();
    const retros = await listRetros(db, "ws");
    expect(retros).toHaveLength(2);
    expect([retros[0]!.windowStart, retros[0]!.windowEnd]).toEqual([MONDAY - HOUR, MONDAY]);
  });
});

describe("failure keeps its window", () => {
  async function fail(db: Db, retroId: string, at: number) {
    const started = (await startRetroAttempt(db, {
      retroId,
      owner: "test",
      now: at,
      leaseMs: 1000,
    }))!;
    await failRetroAttempt(db, {
      retroId,
      attempt: started.attempt,
      owner: "test",
      error: "runner crashed",
      now: at,
    });
  }

  test("a failed retro with a retry left is returned to a manual run with its saved digest", async () => {
    const { db, clock, open } = await world({ retries: 1 });
    const scheduler = open();
    clock.now = MONDAY + HOUR;
    await scheduler.tick();
    const retro = (await listRetros(db, "ws"))[0]!;
    await fail(db, retro.id, clock.now);
    const status = await scheduler.status("ws");
    expect(status.state).toBe("failed");
    expect(status.reason).toBe("runner crashed");
    expect(status.retry?.at).toBeGreaterThan(clock.now);
    const requested = await scheduler.request("ws", "member");
    expect(requested).toMatchObject({ ok: true, created: false, retro: { id: retro.id } });
    expect((await getRetro(db, retro.id))!.digestSha256).toBe(retro.digestSha256);
  });

  test("spent retries stay visible as failed until a new retro over the same activity publishes", async () => {
    const { db, clock, open } = await world({ retries: 0 });
    const scheduler = open();
    clock.now = MONDAY + HOUR;
    await scheduler.tick();
    const failed = (await listRetros(db, "ws"))[0]!;
    await fail(db, failed.id, clock.now);
    expect(await retroWatermarks(db, "ws")).toEqual([]);
    const status = await scheduler.status("ws");
    expect(status.state).toBe("failed");
    expect(status.retry).toBeNull();
    expect(status.lastSuccess).toBeNull();

    clock.now = MONDAY + WEEK + HOUR;
    await scheduler.tick();
    const [replacement, old] = await listRetros(db, "ws");
    expect(old!.state).toBe("abandoned");
    expect(replacement!.windowStart).toBe(MONDAY);
    expect(replacement!.windowEnd).toBe(MONDAY + WEEK);
  });
});

describe("the first window", () => {
  const OTHER_REPO = "pmdroid/other-app";

  async function watermark(db: Db, repository: string, cursor: number) {
    await withoutForeignKeys(db);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.retroWatermark).values({
          workspaceId: "ws",
          repository,
          cursor,
          retroId: "old-retro",
          updatedAt: cursor,
        }),
      (q) => q.orm.execute(sql`SET session_replication_role = origin`),
    );
  }

  test("a repository without a watermark starts one week before a manual or scheduled retro", async () => {
    const manual = await world();
    const at = MONDAY + 2 * DAY;
    manual.clock.now = at;
    expect(await manual.open().request("ws", "member")).toMatchObject({
      ok: true,
      retro: { windowStart: at - WEEK, windowEnd: at },
    });

    const scheduled = await world();
    scheduled.clock.now = MONDAY + HOUR;
    await scheduled.open().tick();
    expect((await listRetros(scheduled.db, "ws"))[0]).toMatchObject({
      origin: "scheduled",
      windowStart: MONDAY - WEEK,
      windowEnd: MONDAY,
    });
  });

  test("a watermark older than a week keeps its longer window", async () => {
    const { db, clock, open } = await world();
    const at = MONDAY + 2 * DAY;
    await watermark(db, FIXTURE_REPO, at - 10 * DAY);
    clock.now = at;
    expect(await open().request("ws", "member")).toMatchObject({
      ok: true,
      retro: { windowStart: at - 10 * DAY, windowEnd: at },
    });
  });

  test("with one repository three days in and one never covered, the window starts a week back", async () => {
    const { db, clock, open } = await world();
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: OTHER_REPO, teamId: "team" }),
    );
    await save(db, SAVED + 1, { repositories: [FIXTURE_REPO, OTHER_REPO] });
    const at = MONDAY + 2 * DAY;
    await watermark(db, FIXTURE_REPO, at - 3 * DAY);
    clock.now = at;
    const requested = await open().request("ws", "member");
    expect(requested).toMatchObject({ ok: true, retro: { windowStart: at - WEEK, windowEnd: at } });
  });
});

describe("schedule HTTP", () => {
  const principal = (userId: string, role: "admin" | "member"): WorkspacePrincipal => ({
    workspaceId: "ws",
    userId,
    role,
    authenticatedAt: 1,
    teamIds: [],
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    new Request(`http://127.0.0.1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("members read status and run a retro; only admins change the schedule; each mutation is audited", async () => {
    const { db, clock, open } = await world();
    clock.now = MONDAY - HOUR;
    const handle = createRetroScheduleHttp({
      store: db,
      scheduler: open(),
      catalog: createFakeRetroCatalog(CATALOGS).read,
      now: () => clock.now,
    });
    const member = principal("member", "member");
    const admin = principal("admin", "admin");
    const read = (await (await handle(
      request(RETRO_SCHEDULE_PATH),
      member,
    ))!.json()) as RetroScheduleStatus & { canEdit: boolean; canRun: boolean };
    expect(read).toMatchObject({ canEdit: false, canRun: true, saved: true, state: "waiting" });
    expect(read.nextRun).toMatchObject({ local: "2026-11-02T09:00+01:00", timeZone: BERLIN });

    const created = await handle(request(RETRO_RUNS_PATH, "POST"), member);
    expect(created!.status).toBe(202);
    const joined = await handle(request(RETRO_RUNS_PATH, "POST"), admin);
    expect(joined!.status).toBe(200);

    const pause = { expectedRevision: 1, schedule: schedule({ cadence: "paused" }) };
    expect((await handle(request(RETRO_SCHEDULE_PATH, "PUT", pause), member))!.status).toBe(403);
    const badZone = { expectedRevision: 1, schedule: schedule({ timeZone: "Mars/Olympus" }) };
    expect((await handle(request(RETRO_SCHEDULE_PATH, "PUT", badZone), admin))!.status).toBe(400);
    const saved = await handle(request(RETRO_SCHEDULE_PATH, "PUT", pause), admin);
    expect(saved!.status).toBe(200);
    const body = (await saved!.json()) as RetroScheduleStatus;
    expect(body).toMatchObject({ settingsRevision: 2, nextRun: null });
    expect(body.schedule.cadence).toBe("paused");
    expect((await handle(request(RETRO_SCHEDULE_PATH, "PUT", pause), admin))!.status).toBe(409);

    expect(
      (
        await db.run((q) =>
          q.all(
            q.orm
              .select({ action: q.t.workspaceAccessAudit.action })
              .from(q.t.workspaceAccessAudit)
              .orderBy(q.t.workspaceAccessAudit.id),
          ),
        )
      ).map((row) => row.action),
    ).toEqual([
      "retros.run.requested",
      "retros.run.joined",
      "access.denied",
      "settings.retros.schedule.saved",
    ]);
  });

  test("before settings are saved the schedule is a proposal and a run is refused", async () => {
    const { db, clock, open } = await world({ settings: false });
    const handle = createRetroScheduleHttp({
      store: db,
      scheduler: open(),
      catalog: createFakeRetroCatalog(CATALOGS).read,
      now: () => clock.now,
    });
    const member = principal("member", "member");
    const status = (await (await handle(
      request(RETRO_SCHEDULE_PATH),
      member,
    ))!.json()) as RetroScheduleStatus;
    expect(status).toMatchObject({ saved: false, nextRun: null, state: "waiting" });
    expect(status.schedule).toMatchObject({ weekday: "monday", time: "09:00" });
    expect((await handle(request(RETRO_RUNS_PATH, "POST"), member))!.status).toBe(409);
    expect(await listRetros(db, "ws")).toHaveLength(0);
  });
});
