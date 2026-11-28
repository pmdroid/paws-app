import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { and, count, eq, lte, min } from "drizzle-orm";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { systemClock } from "../src/core";
import {
  openPawsStore,
  putWorkspaceUser,
  recoverOnStartup,
  registerInstance,
  startLoops,
  stopInstance,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { registerScheduler } from "../src/scheduler";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { workspaceAdmission } from "../test/fake-workspace";
import { pgliteServer } from "../test/pglite";

const { values } = parseArgs({
  options: {
    steps: { type: "string", default: "10" },
    viewers: { type: "string", default: "1000" },
    out: { type: "string", default: process.env.PAWS_EVIDENCE_DIR ?? "capacity-report" },
    "inject-duplicate": { type: "boolean", default: false },
  },
});
const STEPS = values.steps.split(",").map(Number);
const VIEWERS = Number(values.viewers);
const TEAMS = 50;
const POLL_MS = 5_000;
const QUIET_MS = 10_000;
const LINEAR_HOURLY = 5_000;
const ORG = "org-capacity";
const WS = "ws-capacity";

type Role = { viewers: true } | { name: string; origin: string; db: string };
type Tally = { reads: number; linear: number; schedulerMs: number[] };
type Seen = { latencies: number[]; timeouts: number; errors: number; denied: number[] };
type Message =
  | { type: "ready" }
  | { type: "start"; itemId: string; key: string; at: number }
  | { type: "end"; itemId: string }
  | ({ type: "stats" } & Tally)
  | ({ type: "seen" } & Seen);
type Command =
  | { type: "delegate"; n: number }
  | { type: "inject"; itemId: string }
  | { type: "release" }
  | { type: "view"; targets: { urls: string[]; cookie: string }[] }
  | { type: "stop" };

const p95 = (samples: number[]) =>
  samples.length ? [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]! : 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const range = (length: number, from = 0) => Array.from({ length }, (_, k) => from + k);
const send = (message: Message) => process.send!(message);
async function until(done: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !done(); await pause(50)) if (Date.now() > end) return false;
  return true;
}

const role = process.env.PAWS_CAPACITY_ROLE
  ? (JSON.parse(process.env.PAWS_CAPACITY_ROLE) as Role)
  : null;
if (role === null) await main();
else if ("viewers" in role) viewers();
else await worker(role.name, role.origin, role.db);

function viewers() {
  const seen: Seen = { latencies: [], timeouts: 0, errors: 0, denied: [] };
  const polling = { on: true };
  const poll = async (target: { urls: string[]; cookie: string }, viewer: number) => {
    for (await pause(Math.random() * POLL_MS); polling.on; await pause(POLL_MS)) {
      const began = performance.now();
      const init = { headers: { cookie: target.cookie }, signal: AbortSignal.timeout(5_000) };
      try {
        const response = await fetch(target.urls[0]!, init).catch((error) =>
          init.signal.aborted ? Promise.reject(error) : fetch(target.urls[1]!, init),
        );
        await response.arrayBuffer();
        seen.latencies.push(performance.now() - began);
        if (response.status === 401 || response.status === 403) seen.denied.push(viewer);
        else if (!response.ok) seen.errors++;
      } catch (error) {
        if ((error as Error).name === "TimeoutError") seen.timeouts++;
        else seen.errors++;
      }
    }
  };
  let viewing: Promise<unknown> = Promise.resolve();
  process.on("message", async (command: Command) => {
    if (command.type === "view") viewing = Promise.all(command.targets.map(poll));
    if (command.type !== "stop") return;
    polling.on = false;
    await viewing;
    send({ type: "seen", ...seen });
  });
  send({ type: "ready" });
}

async function worker(name: string, origin: string, url: string) {
  const opened = await openPawsStore({ url, pgliteDir: "" });
  const tally: Tally = { reads: 0, linear: 0, schedulerMs: [] };
  const counter = <T extends object>(target: T, keys: string[] | null, field: "reads" | "linear") =>
    new Proxy(target, {
      get(object, key, receiver) {
        const value: unknown = Reflect.get(object, key, receiver);
        if (typeof value !== "function" || (keys && !keys.includes(String(key)))) return value;
        return (...args: unknown[]) => (tally[field]++, value.apply(object, args));
      },
    });
  const store: Db = counter(opened.store, ["run", "transaction"], "reads");
  const instance = await registerInstance(opened.store, {
    ...{ role: "all", host: name, version: null, now: Date.now() },
  });
  await recoverOnStartup(opened.store, Date.now(), undefined, instance.id);
  const issues = range(STEPS.reduce((sum, runs) => sum + runs, 0)).map((n) => ({
    ...{ linearIssueId: `issue-${n}`, identifier: `CAP-${n + 1}`, title: `Answer part ${n + 1}` },
    ...{ description: null, subIssues: [] },
  }));
  let release = Promise.withResolvers<void>();
  const turn = async (options: RunAgentOptions, text: string, hold: boolean) => {
    if (hold) {
      const key = /CAP-\d+/.exec(options.prompt)?.[0] ?? options.itemId;
      send({ type: "start", itemId: options.itemId, key, at: Date.now() });
      const aborted = Promise.withResolvers<void>();
      options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([release.promise, aborted.promise]);
      send({ type: "end", itemId: options.itemId });
    }
    const cancelled = options.signal?.aborted === true;
    if (!cancelled)
      await options.onEvent?.({
        type: "session_update",
        sessionId: "agent",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    return {
      ...{ role: options.role, stopReason: cancelled ? "cancelled" : "end_turn", cancelled },
      ...{ timedOut: false, authRequired: false, agentExited: true },
      identity: { session: "agent", model: "test-claude-model", provider: "claude" },
    } satisfies RunAgentResult;
  };
  const home = join(tmpdir(), `paws-capacity-${name}-${process.pid}`);
  mkdirSync(join(home, "paws"), { recursive: true });
  const stop = new AbortController();
  let orchestrator: ReturnType<typeof attachOrchestrator> | undefined;
  const loops = await startLoops({
    db: store,
    instanceId: instance.id,
    signal: stop.signal,
    async prepare({ jobs, outbox }) {
      orchestrator = attachOrchestrator({
        ...{ store, jobs, outbox, home, pawsRoot: join(home, "paws"), clock: systemClock },
        admission: workspaceAdmission(store),
        tracker: counter(createFakeTracker(issues), null, "linear"),
        instanceId: instance.id,
        linearTaskModes: true,
        scheduling: async () => ({}),
        launch: () => {
          throw new Error("Remote execution must not launch a local agent");
        },
        remoteExecution: {
          slotFree: async () => true,
          agentForSession: () => (options) => turn(options, '{"mode":"answer"}', false),
          agentForItem: () => (options) => turn(options, "Done.", true),
        },
      });
      await registerScheduler(jobs, async () => {
        const began = performance.now();
        await orchestrator!.reconcileExecution();
        tally.schedulerMs.push(performance.now() - began);
      });
    },
  });
  const unused = () => Promise.reject(new Error("The capacity test reads no Linear membership"));
  const http = startServer({
    ...{ port: Number(new URL(origin).port), hostname: "127.0.0.1", db: opened.store },
    evidenceDir: join(home, "evidence"),
    workspaceAccess: createWorkspaceAccess({
      ...{ store: opened.store, publicUrl: origin, clientId: "capacity" },
      installedOrganization: { id: ORG, name: "Capacity" },
      memberships: { installation: unused, member: unused },
    }),
  });
  const reporting = setInterval(() => {
    send({ type: "stats", ...tally });
    Object.assign(tally, { reads: 0, linear: 0, schedulerMs: [] });
  }, 500);
  process.on("message", (command: Command) => {
    if (command.type === "inject")
      send({ type: "start", itemId: command.itemId, key: "injected", at: Date.now() });
    if (command.type === "release") {
      release.resolve();
      release = Promise.withResolvers<void>();
    }
    if (command.type !== "delegate") return;
    void orchestrator!.onLinearEvent({
      ...{ dedupeKey: `created:${command.n}`, deliveryId: null, source: "webhook" },
      ...{ action: "created", sessionId: `session-${command.n}`, issueId: `issue-${command.n}` },
      ...{ activityId: null, actorId: null, body: null, signal: null, updatedAtMs: Date.now() },
      payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
    });
  });
  process.on("SIGTERM", async () => {
    clearInterval(reporting);
    stop.abort();
    await orchestrator!.shutdown().catch(() => undefined);
    await loops.stop();
    await http.stop(true);
    await stopInstance(opened.store, instance.id, Date.now());
    await opened.close();
    rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
  send({ type: "ready" });
}

function member(db: Db, n: number, active: boolean) {
  return syncWorkspaceMember(db, {
    ...{ workspaceId: WS, userId: `viewer-${n}`, role: n ? "member" : "admin", active },
    ...{ teamIds: [`team-${n % TEAMS}`], now: Date.now() },
  });
}

async function seed(db: Db) {
  await db.run((q) =>
    q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: WS, linearOrganizationId: ORG, name: "Capacity", createdAt: 0 }),
    ),
  );
  const cookies: string[] = [];
  for (const n of range(VIEWERS)) {
    const userId = await putWorkspaceUser(db, {
      ...{ id: `viewer-${n}`, linearUserId: `viewer-${n}`, name: `Viewer ${n}` },
      email: `viewer-${n}@capacity.invalid`,
    });
    await member(db, n, true);
    const { token } = await issueWorkspaceSession(db, { workspaceId: WS, userId, now: Date.now() });
    cookies.push(`${WORKSPACE_COOKIE}=${token}`);
  }
  for (const from of range(4).map((k) => k * 250))
    await db.run(function* (q) {
      const rows = range(250, from);
      yield* q.exec(
        q.orm.insert(q.t.linearSession).values(
          rows.map((n) => ({
            ...{ sessionId: `history-${n}`, organizationId: ORG, oauthClientId: "capacity" },
            ...{ appUserId: "app", teamId: `team-${n % TEAMS}`, installationObservedAt: 1 },
            createdAt: n,
          })),
        ),
      );
      yield* q.exec(
        q.orm.insert(q.t.workItem).values(
          rows.map((n) => ({
            ...{ id: `history-${n}`, delegationId: `history-${n}`, sessionKey: `history-${n}` },
            ...{ linearIssueId: `history-issue-${n}`, linearIdentifier: `OLD-${n}` },
            ...{ title: `Finished part ${n} in acme/repo-${n % TEAMS}`, state: "completed" },
            ...{ branchName: `paws/history-${n}`, position: n, createdAt: n },
          })),
        ),
      );
    });
  for (const from of range(10).map((k) => k * 1_000))
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.job).values(
          range(1_000, from).map((n) => ({
            ...{ queue: "dispatch", payload: { itemId: `history-${n % 1_000}` }, runAt: n },
            ...{ status: "done", createdAt: n, finishedAt: n + 1 },
          })),
        ),
      ),
    );
  return cookies;
}

async function main() {
  mkdirSync(values.out, { recursive: true });
  const server = await pgliteServer(process.env, { maxConnections: 32 });
  const db = server.store;
  const cookies = await seed(db);
  const origins = await Promise.all(
    range(2).map(async () => {
      const held = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const origin = `http://127.0.0.1:${held.port}`;
      await held.stop(true);
      return origin;
    }),
  );
  const active = new Map<string, string>();
  const duplicates: string[] = [];
  const startedAt = new Map<string, number>();
  const totals: Tally = { reads: 0, linear: 0, schedulerMs: [] };
  let seen: Seen | null = null;
  let spawns = 0;
  const spawn = async (name: string, as: Role) => {
    const ready = Promise.withResolvers<void>();
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", import.meta.path, "--steps", values.steps],
      env: { ...process.env, PAWS_CAPACITY_ROLE: JSON.stringify(as) },
      stdout: "ignore",
      stderr: Bun.file(join(values.out, `${name}-${++spawns}.log`)),
      ipc(message: Message) {
        if (message.type === "ready") ready.resolve();
        if (message.type === "seen") seen = message;
        if (message.type === "end") active.delete(message.itemId);
        if (message.type === "stats") {
          totals.reads += message.reads;
          totals.linear += message.linear;
          totals.schedulerMs.push(...message.schedulerMs);
        }
        if (message.type !== "start") return;
        if (active.has(message.itemId)) duplicates.push(`${message.itemId} on ${name}`);
        active.set(message.itemId, name);
        if (!startedAt.has(message.key)) startedAt.set(message.key, message.at);
      },
    });
    void child.exited.then(() => {
      for (const [itemId, owner] of active) if (owner === name) active.delete(itemId);
      ready.reject(new Error(`${name} exited before it was ready`));
    });
    await ready.promise;
    return child;
  };
  const pawsWorker = (n: number) =>
    spawn(`paws-${"ab"[n]}`, {
      ...{ name: `paws-${"ab"[n]}`, origin: origins[n]! },
      db: server.url.replace("max=1&", ""),
    });
  const workers = [await pawsWorker(0), await pawsWorker(1)];
  const targets = cookies.map((cookie, n) => ({
    urls: [n, n + 1].map((k) => origins[k % 2] + (n % 2 ? "/api/overview" : "/api/issues")),
    cookie,
  }));
  const report: Record<string, number | boolean | string>[] = [];
  let delegated = 0;
  for (const [index, runs] of STEPS.entries()) {
    const backlog: { n: number; oldestMs: number }[] = [];
    const sampling = { on: true };
    const viewing = await spawn("viewers", { viewers: true });
    viewing.send({ type: "view", targets } satisfies Command);
    const sampler = (async () => {
      for (; sampling.on; await pause(1_000)) {
        const row = await db.run((q) =>
          q.one(
            q.orm
              .select({ n: count(), oldest: min(q.t.job.runAt) })
              .from(q.t.job)
              .where(and(eq(q.t.job.status, "pending"), lte(q.t.job.runAt, Date.now()))),
          ),
        );
        backlog.push({ n: row?.n ?? 0, oldestMs: row?.oldest ? Date.now() - row.oldest : 0 });
      }
    })();
    const delegatedAt = new Map<string, number>();
    for (const n of range(runs, delegated)) {
      delegatedAt.set(`CAP-${n + 1}`, Date.now());
      workers[n % 2]!.send({ type: "delegate", n } satisfies Command);
    }
    delegated += runs;
    const startedAll = await until(() => active.size >= runs, 120_000);
    if (values["inject-duplicate"]) {
      const [itemId, owner] = [...active][0]!;
      workers[owner === "paws-a" ? 1 : 0]!.send({ type: "inject", itemId } satisfies Command);
      await until(() => duplicates.length > 0, 5_000);
    }
    const reads = totals.reads;
    await pause(QUIET_MS);
    const quietReads = totals.reads - reads;
    await member(db, index + 1, false);
    const revoked = pause(2 * POLL_MS);
    workers[1]!.kill("SIGTERM");
    await workers[1]!.exited;
    workers[1] = await pawsWorker(1);
    const restartedAll = await until(() => active.size >= runs, 120_000);
    for (const each of workers) each.send({ type: "release" } satisfies Command);
    const settled = startedAll && restartedAll && (await until(() => active.size === 0, 60_000));
    await revoked;
    sampling.on = false;
    seen = null;
    viewing.send({ type: "stop" } satisfies Command);
    await until(() => seen !== null, 30_000);
    viewing.kill();
    await sampler;
    const dashboard: Seen = seen ?? { latencies: [], timeouts: VIEWERS, errors: 0, denied: [] };
    const tail = backlog.slice(-5);
    const step = {
      ...{ activeRuns: runs, viewers: VIEWERS, dashboardRequests: dashboard.latencies.length },
      dashboardP95Ms: Math.round(p95(dashboard.latencies)),
      dashboardTimeouts: dashboard.timeouts,
      dashboardErrors: dashboard.errors,
      revokedViewerDenied: dashboard.denied.includes(index + 1),
      oldestRunnableJobMs: Math.max(0, ...backlog.map((each) => each.oldestMs)),
      runnableBacklog: tail.map((each) => each.n).join(" "),
      delegationToStartP95Ms: Math.round(
        p95([...delegatedAt].map(([key, at]) => (startedAt.get(key) ?? Date.now()) - at)),
      ),
      schedulerPassP95Ms: Math.round(p95(totals.schedulerMs.splice(0))),
      readsPerQuietRunPerMinute: Math.round((quietReads / runs) * (60_000 / QUIET_MS)),
      linearCalls: totals.linear,
      providerThrottled: Math.max(0, totals.linear - LINEAR_HOURLY),
      duplicateClaims: duplicates.splice(0).join(", ") || 0,
      runsSettledThroughRestart: settled,
    };
    const passed =
      step.dashboardP95Ms < 1_000 &&
      step.dashboardTimeouts + step.dashboardErrors === 0 &&
      step.revokedViewerDenied &&
      step.oldestRunnableJobMs < 30_000 &&
      step.duplicateClaims === 0 &&
      settled;
    report.push({ ...step, passed });
  }
  for (const each of workers) each.kill("SIGTERM");
  await Promise.all(workers.map((each) => each.exited));
  await server.close();
  writeFileSync(join(values.out, "capacity.json"), `${JSON.stringify(report, null, 2)}\n`);
  const keys = Object.keys(report[0]!);
  const rows = [keys, keys.map(() => "---"), ...report.map((step) => keys.map((key) => step[key]))];
  writeFileSync(
    join(values.out, "capacity.md"),
    `# Capacity: ${VIEWERS} viewers, two Paws workers\n\n${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}\n`,
  );
  console.log(`Wrote capacity.json and capacity.md to ${values.out}`);
  process.exit(report.every((step) => step.passed) ? 0 : 1);
}
