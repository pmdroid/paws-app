import {
  alertFactsSteps,
  closeoutTestFailuresSteps,
  closeoutTestPassesSteps,
  inboxBacklogSteps,
  metricMinutesSteps,
  orphanedBlockerFactsSteps,
  type AlertJobRow,
  type CloseoutTestFailureRow,
  type CloseoutTestPass,
  type Db,
  type OrphanedBlockerRow,
} from "../db";
import { deployLagAlerts, type DeployLagCheck } from "./deploy-lag";

export const ALERTS_PATH = "/api/alerts";

const MINUTE_MS = 60_000;
export const RUNNER_4XX_THRESHOLD = 30;
export const RUNNER_4XX_WINDOW_MS = 10 * MINUTE_MS;
export const REPEATED_FAILURE_ATTEMPTS = 5;
export const REPEATED_FAILURE_WINDOW_MS = 24 * 60 * MINUTE_MS;
export const TEST_TIMEOUT_THRESHOLD = 3;
export const TEST_TIMEOUT_WINDOW_MS = 2 * 60 * MINUTE_MS;
export const DEAD_OUTBOX_WINDOW_MS = 60 * MINUTE_MS;
export const IDLE_FREE_SLOTS = 2;
export const IDLE_WINDOW_MS = 30 * MINUTE_MS;
export const INTAKE_BACKLOG_WARNING_MS = 10 * MINUTE_MS;
export const INTAKE_BACKLOG_CRITICAL_MS = 30 * MINUTE_MS;
export const ORPHANED_BLOCKER_MS = 30 * MINUTE_MS;
export const SHARED_FAILURE_ITEMS = 2;
export const SHARED_FAILURE_WINDOW_MS = 24 * 60 * MINUTE_MS;

export type AlertSeverity = "critical" | "warning" | "info";

export type Alert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  since: number;
  count: number;
};

function runnerHttp4xx(
  rows: readonly { minute: number; labels: Record<string, string>; count: number }[],
): Alert[] {
  const routes = new Map<string, { count: number; since: number }>();
  for (const row of rows) {
    const route = row.labels.route ?? "";
    if (!route.startsWith("/v1/") || row.labels.status_class !== "4xx") continue;
    const found = routes.get(route) ?? { count: 0, since: row.minute };
    routes.set(route, { count: found.count + row.count, since: Math.min(found.since, row.minute) });
  }
  return [...routes]
    .filter(([, { count }]) => count >= RUNNER_4XX_THRESHOLD)
    .map(([route, { count, since }]) => ({
      id: `runner_http_4xx:${route}`,
      severity: "critical",
      title: `Runner route ${route} answered ${count} client errors`,
      detail: `${route} answered ${count} 4xx responses in the last ${RUNNER_4XX_WINDOW_MS / MINUTE_MS} minutes.`,
      since,
      count,
    }));
}

function repeatedFailures(jobs: readonly AlertJobRow[]): Alert[] {
  const byItem = new Map<string, AlertJobRow[]>();
  for (const job of jobs) byItem.set(job.itemId, [...(byItem.get(job.itemId) ?? []), job]);
  const alerts: Alert[] = [];
  for (const [itemId, rows] of byItem) {
    const error = rows[0]?.lastError ?? null;
    if (error === null) continue;
    let attempts = 0;
    let since = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (row.status === "done" || row.status === "cancelled" || row.lastError !== error) break;
      attempts += row.status === "running" ? row.attempts - 1 : row.attempts;
      since = Math.min(since, row.at);
    }
    if (attempts < REPEATED_FAILURE_ATTEMPTS) continue;
    const name = rows[0]?.identifier ?? itemId;
    alerts.push({
      id: `repeated_failure:${itemId}`,
      severity: "critical",
      title: `${name} failed ${attempts} times with the same error`,
      detail: error,
      since,
      count: attempts,
    });
  }
  return alerts;
}

function testTimeouts(finishedAt: readonly number[]): Alert[] {
  if (finishedAt.length < TEST_TIMEOUT_THRESHOLD) return [];
  return [
    {
      id: "test_timeouts",
      severity: "warning",
      title: `Closeout's test check timed out ${finishedAt.length} times`,
      detail: `${finishedAt.length} Closeout test steps timed out in the last ${TEST_TIMEOUT_WINDOW_MS / (60 * MINUTE_MS)} hours.`,
      since: Math.min(...finishedAt),
      count: finishedAt.length,
    },
  ];
}

function deadOutbox(
  rows: readonly { id: number; op: string; error: string | null; at: number }[],
): Alert[] {
  const groups = new Map<string, { id: number; op: string; error: string; at: number[] }>();
  for (const row of rows) {
    const error = row.error ?? "No error recorded.";
    const key = JSON.stringify([row.op, error]);
    const found = groups.get(key) ?? { id: row.id, op: row.op, error, at: [] };
    groups.set(key, { ...found, at: [...found.at, row.at] });
  }
  return [...groups.values()].map((group) => ({
    id: `dead_outbox:${group.op}:${group.id}`,
    severity: "warning",
    title: `Outbox ${group.op} delivery went dead`,
    detail: group.error,
    since: Math.min(...group.at),
    count: group.at.length,
  }));
}

function idleCapacity(
  facts: { queuedNow: boolean; lastQueuedAt: number | null; freeSlots: number },
  now: number,
): Alert[] {
  if (facts.freeSlots < IDLE_FREE_SLOTS || facts.queuedNow) return [];
  if (facts.lastQueuedAt !== null && facts.lastQueuedAt > now - IDLE_WINDOW_MS) return [];
  return [
    {
      id: "idle_capacity",
      severity: "info",
      title: `${facts.freeSlots} runner slots are free and nothing is queued`,
      detail: `No item has been queued for ${IDLE_WINDOW_MS / MINUTE_MS} minutes.`,
      since: facts.lastQueuedAt ?? now - IDLE_WINDOW_MS,
      count: facts.freeSlots,
    },
  ];
}

function intakeBacklog(backlog: { depth: number; oldestAt: number }, now: number): Alert[] {
  const age = now - backlog.oldestAt;
  if (backlog.depth === 0 || age <= INTAKE_BACKLOG_WARNING_MS) return [];
  const minutes = Math.floor(age / MINUTE_MS);
  return [
    {
      id: "intake_backlog",
      severity: age >= INTAKE_BACKLOG_CRITICAL_MS ? "critical" : "warning",
      title: `Linear intake is ${minutes} minutes behind`,
      detail: `${backlog.depth} Linear events wait for intake; the oldest arrived ${minutes} minutes ago.`,
      since: backlog.oldestAt,
      count: backlog.depth,
    },
  ];
}

export function orphanedBlockers(rows: readonly OrphanedBlockerRow[], now: number): Alert[] {
  const groups = new Map<string, { row: OrphanedBlockerRow; blocked: string[]; since: number }>();
  for (const row of rows) {
    const since = Math.max(row.heldSince, row.endedAt);
    if (now - since < ORPHANED_BLOCKER_MS) continue;
    const found = groups.get(row.blocker) ?? { row, blocked: [], since };
    if (!found.blocked.includes(row.blocked)) found.blocked.push(row.blocked);
    groups.set(row.blocker, { ...found, since: Math.min(found.since, since) });
  }
  return [...groups.values()].map(({ row, blocked, since }) => {
    const listed = [...blocked].sort().slice(0, 5).join(", ");
    const more = blocked.length - 5;
    return {
      id: `orphaned_blocker:${row.blocker}`,
      severity: "warning",
      title: `${row.blocker} has no live Paws item (${row.state} ${new Date(row.endedAt).toISOString().slice(11, 16)}) and blocks ${listed}${more > 0 ? ` and ${more} more` : ""}`,
      detail: `${blocked.length === 1 ? "1 queued item waits" : `${blocked.length} queued items wait`} on ${row.blocker}, whose latest Paws item is ${row.state}. Delegate ${row.blocker} again or remove the blocking relation.`,
      since,
      count: blocked.length,
    };
  });
}

const PROOF_FAIL = /^FAIL ([\w.-]+):/gm;

function failingTests(row: CloseoutTestFailureRow): { file: string; name: string }[] {
  const tests = row.failedTests.flatMap((t) =>
    t.file ? [{ file: t.file, name: t.name ?? "" }] : [],
  );
  if (tests.length > 0) return tests;
  return [...row.output.matchAll(PROOF_FAIL)].map((match) => ({
    file: `test/proofs/${match[1]}.ts`,
    name: "",
  }));
}

function sharedFailureNeedle(file: string): string {
  const proof = /^test\/proofs\/(.+)\.ts$/.exec(file);
  return proof ? `PASS ${proof[1]} (` : file;
}

type FailureGroup = { file: string; name: string; items: Map<string, number>; bases: Set<string> };

function failureGroups(rows: readonly CloseoutTestFailureRow[], now: number): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const row of rows) {
    if (now - row.at > SHARED_FAILURE_WINDOW_MS) continue;
    for (const test of failingTests(row)) {
      if (row.changedPaths?.includes(test.file)) continue;
      const key = JSON.stringify([test.file, test.name]);
      const group = groups.get(key) ?? { ...test, items: new Map(), bases: new Set() };
      group.items.set(row.identifier, Math.max(group.items.get(row.identifier) ?? 0, row.at));
      group.bases.add(row.base);
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter((group) => group.items.size >= SHARED_FAILURE_ITEMS);
}

export function sharedCheckFailures(
  rows: readonly CloseoutTestFailureRow[],
  passes: readonly CloseoutTestPass[],
  now: number,
): Alert[] {
  const alerts: Alert[] = [];
  for (const { file, name, items, bases } of failureGroups(rows, now)) {
    const last = Math.max(...items.values());
    if (passes.some((pass) => pass.file === file && pass.at > last && !bases.has(pass.base)))
      continue;
    const ordered = [...items].sort((a, b) => b[1] - a[1]).map(([identifier]) => identifier);
    const listed = ordered.slice(0, 5);
    const more = ordered.length - listed.length;
    const named =
      more > 0
        ? `${listed.join(", ")} and ${more} more`
        : `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
    const test = name === "" ? `\`${file}\`` : `\`${file}\` "${name}"`;
    alerts.push({
      id: `shared_check_failure:${file}:${name}`,
      severity: "warning",
      title: `${test} fails Closeout for ${named}: likely broken on main, fix it in its own issue`,
      detail: `${test} failed Closeout for ${items.size} items in the last ${SHARED_FAILURE_WINDOW_MS / (60 * MINUTE_MS)} hours, and none of them changed ${file}.`,
      since: Math.min(...items.values()),
      count: items.size,
    });
  }
  return alerts;
}

export async function readAlerts(
  db: Db,
  now = Date.now(),
  deployLag?: DeployLagCheck,
): Promise<Alert[]> {
  const from = Math.floor((now - RUNNER_4XX_WINDOW_MS) / MINUTE_MS) * MINUTE_MS;
  const metrics = await db.run((q) =>
    metricMinutesSteps(q, { names: ["http.request"], from, to: now + MINUTE_MS }),
  );
  const facts = await db.run((q) =>
    alertFactsSteps(q, now, {
      jobs: now - REPEATED_FAILURE_WINDOW_MS,
      testTimeouts: now - TEST_TIMEOUT_WINDOW_MS,
      deadOutbox: now - DEAD_OUTBOX_WINDOW_MS,
    }),
  );
  const backlog = await db.run((q) => inboxBacklogSteps(q, now));
  const orphans = await db.run((q) => orphanedBlockerFactsSteps(q));
  const failures = await db.run((q) =>
    closeoutTestFailuresSteps(q, now - SHARED_FAILURE_WINDOW_MS),
  );
  const files = new Set(failureGroups(failures, now).map((group) => group.file));
  const passes = await db.run((q) =>
    closeoutTestPassesSteps(
      q,
      now - SHARED_FAILURE_WINDOW_MS,
      [...files].map((file) => ({ file, needle: sharedFailureNeedle(file) })),
    ),
  );
  return [
    ...runnerHttp4xx(metrics),
    ...repeatedFailures(facts.jobs),
    ...testTimeouts(facts.testTimeouts),
    ...deadOutbox(facts.deadOutbox),
    ...idleCapacity(facts, now),
    ...intakeBacklog(backlog, now),
    ...orphanedBlockers(orphans, now),
    ...sharedCheckFailures(failures, passes, now),
    ...(deployLag ? await deployLagAlerts(deployLag, now) : []),
  ].sort((a, b) => b.since - a.since);
}
