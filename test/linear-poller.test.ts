import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { intakeDelegatedIssue } from "../src/intake";
import { configureWorkItem, insertQueuedItem } from "../src/db";
import { RunnerSlotsBusyError } from "../src/core";
import {
  POLL_INTERVAL_ACTIVE_MS,
  POLL_INTERVAL_IDLE_MS,
  POLL_INTERVAL_LOW_BUDGET_MS,
  POLL_INTERVAL_WEBHOOK_MS,
  WAKE_GAP_MS,
  WEBHOOK_HEALTHY_MS,
  createInboxStore,
  handleLinearWebhook,
  lastVerifiedWebhookMs,
  createIntakePollSource,
  createLinearClient,
  createLinearTracker,
  LinearEntityNotFoundError,
  linearBudget,
  linearWorkIsHot,
  openLinear,
  pollIntervalMs,
  sleepGapMs,
  startCatchUpPoller,
  webhookChecksNeeded,
  type LinearAuth,
  type LinearRateBudget,
  type AcceptedLinearEvent,
  type Sleeper,
} from "../src/linear";
import { tempDb, tempHome } from "./helpers";

const NOW = 1_700_000_000_000;
const TEAM = "team_1";

describe("linear intake poll", () => {
  test("preserves every own active session without any agent activities", async () => {
    const db = tempDb();
    const seen: AcceptedLinearEvent[] = [];
    const { client } = scripted(() => ({
      ...page([issue("iss_delegate", "ENG-8", [], "app_1")]),
      agentSessions: {
        nodes: [
          session("session-old", "iss_delegate", NOW - 1_000),
          session("session-new", "iss_delegate", NOW),
          {
            ...session("session-ended", "iss_delegate", NOW + 3_000),
            endedAt: new Date(NOW + 4_000).toISOString(),
          },
          {
            ...session("session-dismissed", "iss_delegate", NOW + 3_000),
            dismissedAt: new Date(NOW + 4_000).toISOString(),
          },
          {
            ...session("session-other-app", "iss_delegate", NOW + 1_000),
            appUser: { id: "other" },
          },
          {
            ...session("session-other-team", "iss_delegate", NOW + 2_000),
            issue: { id: "iss_delegate", team: { id: "other-team", key: "OTHER" } },
          },
        ],
      },
    }));
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store: createInboxStore(db),
      onEvent: (event) => {
        seen.push(event);
      },
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => seen.length > 0);
    await poller.stop();
    await poller.settled;
    db.close();
    expect(seen.map((event) => event.sessionId)).toEqual(["session-old", "session-new"]);
  });

  test.each([200, 400])(
    "the Linear client reports a missing entity with HTTP %i as LinearEntityNotFoundError",
    async (status) => {
      const client = createLinearClient({
        auth: AUTH,
        fetch: async () =>
          new Response(
            JSON.stringify({ errors: [{ message: "Entity not found: AgentSession" }] }),
            { status, headers: { "content-type": "application/json" } },
          ),
      });
      const failure = await client.query("query { x }", {}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LinearEntityNotFoundError);
      expect((failure as LinearEntityNotFoundError).entity).toBe("AgentSession");
    },
  );

  test("a session deleted in Linear is skipped and does not block later sessions", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const seen: (string | null)[] = [];
    const attempts: (string | null)[] = [];
    const { client } = scripted(() => ({
      ...page([issue("iss_gone", "ENG-8", [], "app_1"), issue("iss_live", "ENG-9", [], "app_1")]),
      agentSessions: {
        nodes: [
          session("session-gone", "iss_gone", NOW - 1_000),
          session("session-live", "iss_live", NOW),
        ],
      },
    }));
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store,
      onEvent: (event) => {
        attempts.push(event.sessionId);
        if (event.sessionId === "session-gone")
          throw new LinearEntityNotFoundError("Entity not found: AgentSession");
        seen.push(event.sessionId);
      },
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => seen.length > 0);
    await poller.pollNow();
    await poller.stop();
    await poller.settled;
    db.close();
    expect(seen).toEqual(["session-live"]);
    expect(attempts.filter((id) => id === "session-gone")).toEqual(["session-gone"]);
  });

  test("a session waiting for a runner slot does not block later sessions and is retried", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const seen: (string | null)[] = [];
    let busy = true;
    const { client } = scripted(() => ({
      ...page([issue("iss_busy", "ENG-8", [], "app_1"), issue("iss_next", "ENG-9", [], "app_1")]),
      agentSessions: {
        nodes: [
          session("session-busy", "iss_busy", NOW - 1_000),
          session("session-next", "iss_next", NOW),
        ],
      },
    }));
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store,
      onEvent: (event) => {
        if (event.sessionId === "session-busy" && busy) throw new RunnerSlotsBusyError();
        seen.push(event.sessionId);
      },
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => seen.includes("session-next"));
    busy = false;
    await poller.pollNow();
    await poller.stop();
    await poller.settled;
    db.close();
    expect(seen).toEqual(["session-next", "session-busy"]);
  });

  test.each([false, true])(
    "an issue delegated again into its earlier session is taken in again unless it has a task (task=%s)",
    async (withTask) => {
      const db = tempDb();
      const store = createInboxStore(db);
      if (withTask) insertQueuedItem(db, { sessionKey: "session-reused" });
      const created: string[] = [];
      let polls = 0;
      const { client } = scripted(() => {
        polls += 1;
        return {
          ...page([
            {
              ...issue("iss_back", "ENG-8", [], "app_1"),
              updatedAt: new Date(NOW + polls * 1_000).toISOString(),
            },
          ]),
          agentSessions: { nodes: [session("session-reused", "iss_back", NOW - 1_000)] },
        };
      });
      const poller = startCatchUpPoller({
        source: createIntakePollSource(client, { teamId: TEAM }),
        store,
        db,
        onEvent: (event) => {
          if (event.action !== "created") return;
          created.push(event.dedupeKey);
          return created.length > 1;
        },
        sleeper: blockedSleeper(),
        now: () => NOW,
      });
      await waitFor(() => created.length > 0);
      await poller.pollNow();
      store.setCursor("delegated:iss_back", NOW + 60_000);
      await poller.pollNow();
      await poller.pollNow();
      await poller.stop();
      await poller.settled;
      db.close();
      expect(created.length).toBe(withTask ? 1 : 2);
    },
  );

  test.each([true, false])(
    "attaches a late session once with issue present=%s",
    async (issuePresent) => {
      const db = tempDb();
      const store = createInboxStore(db);
      const seen: AcceptedLinearEvent[] = [];
      let polls = 0;
      const { client } = scripted(() => {
        polls += 1;
        return {
          ...page(polls === 1 || issuePresent ? [issue("iss_delegate", "ENG-8", [], "app_1")] : []),
          agentSessions: {
            nodes: polls === 1 ? [] : [session("session-late", "iss_delegate", NOW)],
          },
        };
      });
      const poller = startCatchUpPoller({
        source: createIntakePollSource(client, { teamId: TEAM }),
        store,
        onEvent: (event) => {
          seen.push(event);
        },
        sleeper: blockedSleeper(),
        now: () => NOW + 60_000,
      });
      await waitFor(() => seen.length > 0);
      await poller.pollNow();
      await poller.pollNow();
      await poller.stop();
      await poller.settled;
      db.close();
      expect(seen.map((event) => event.sessionId)).toEqual([null, "session-late"]);
    },
  );

  test.each([
    { team: "cda507e8-3b78-4fe3-a6c1-170e8a82508f", field: "id" },
    { team: "ENG", field: "key" },
  ])("uses a typed team filter for $field", async ({ team, field }) => {
    const { client } = scripted(({ query, variables }) => {
      expect(query).toContain("$team: TeamFilter!");
      expect(variables["team"]).toEqual({ [field]: { eq: team } });
      return page([]);
    });
    const source = createIntakePollSource(client, { teamId: team });
    const result = await source.poll(NOW);
    expect(result.queried).toBe(true);
    expect(result.caughtUp).toBe(true);
  });

  test("waits 5s while work is active and 15s while idle", async () => {
    expect(pollIntervalMs(true)).toBe(POLL_INTERVAL_ACTIVE_MS);
    expect(pollIntervalMs(false)).toBe(POLL_INTERVAL_IDLE_MS);
    expect(pollIntervalMs(true)).toBe(5_000);
    expect(pollIntervalMs(false)).toBe(15_000);
    expect(
      sleepGapMs({ previousWallMs: 0, previousMonoMs: 0, wallMs: 120_000, monoMs: 1_000 }),
    ).toBeGreaterThan(WAKE_GAP_MS);
    expect(webhookChecksNeeded({})).toBe(false);
    expect(webhookChecksNeeded({ LINEAR_WEBHOOKS: "true" })).toBe(true);
    expect(webhookChecksNeeded({ LINEAR_WEBHOOKS: "1" })).toBe(true);

    const db = tempDb();
    const store = createInboxStore(db);
    let hot = false;
    const waits: number[] = [];
    const gate = hold();
    const poller = startCatchUpPoller({
      source: sourceFrom(async () => emptyPage()),
      store,
      onEvent: () => {},
      hot: () => hot,
      sleeper: recordingSleeper(waits, gate),
      now: () => NOW,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    expect(waits).toEqual([POLL_INTERVAL_IDLE_MS]);
    hot = true;
    gate.release?.();
    await waitFor(() => waits.length > 1);
    expect(waits[1]).toBe(POLL_INTERVAL_ACTIVE_MS);
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("backs off to 60s while verified webhooks arrive and 5 minutes on a low budget", () => {
    const fresh = { now: NOW, lastWebhookMs: NOW - WEBHOOK_HEALTHY_MS + 1 };
    expect(pollIntervalMs(true, fresh)).toBe(POLL_INTERVAL_WEBHOOK_MS);
    expect(pollIntervalMs(false, fresh)).toBe(60_000);

    const stale = { now: NOW, lastWebhookMs: NOW - WEBHOOK_HEALTHY_MS };
    expect(pollIntervalMs(true, stale)).toBe(POLL_INTERVAL_ACTIVE_MS);
    expect(pollIntervalMs(false, stale)).toBe(POLL_INTERVAL_IDLE_MS);
    expect(pollIntervalMs(true, { now: NOW, lastWebhookMs: null, budget: null })).toBe(5_000);

    const low = rateBudget({
      requestsRemaining: 199,
      requestsLimit: 1_000,
      requestsResetMs: NOW + 1,
    });
    expect(pollIntervalMs(true, { now: NOW, budget: low })).toBe(POLL_INTERVAL_LOW_BUDGET_MS);
    expect(pollIntervalMs(false, { now: NOW, budget: low, lastWebhookMs: NOW })).toBe(300_000);
    expect(pollIntervalMs(true, { now: NOW + 1, budget: low })).toBe(POLL_INTERVAL_ACTIVE_MS);
    const enough = rateBudget({ requestsRemaining: 200, requestsLimit: 1_000 });
    expect(pollIntervalMs(false, { now: NOW, budget: enough })).toBe(POLL_INTERVAL_IDLE_MS);
    expect(pollIntervalMs(false, { now: NOW, budget: rateBudget({}) })).toBe(POLL_INTERVAL_IDLE_MS);
  });

  test("waits 60s after a verified webhook and keeps today's intervals without one", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const waits: number[] = [];
    const gate = hold();
    let clock = NOW;
    const poller = startCatchUpPoller({
      source: sourceFrom(async () => emptyPage()),
      store,
      onEvent: () => {},
      hot: () => true,
      sleeper: recordingSleeper(waits, gate),
      now: () => clock,
      mono: () => clock - NOW,
    });
    await waitFor(() => waits.length > 0);
    expect(waits[0]).toBe(POLL_INTERVAL_ACTIVE_MS);

    const body = JSON.stringify({
      type: "AgentSessionEvent",
      action: "created",
      webhookTimestamp: NOW,
      agentSession: { id: "session-webhook", issueId: "iss_webhook" },
    });
    const response = await handleLinearWebhook(
      new Request("http://127.0.0.1/webhooks/linear", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": createHmac("sha256", "secret").update(body).digest("hex"),
          "linear-delivery": "delivery-1",
        },
        body,
      }),
      "secret",
      { store, now: () => NOW },
    );
    expect(response.status).toBe(200);
    expect(lastVerifiedWebhookMs(store)).toBe(NOW);
    gate.release?.();
    await waitFor(() => waits.length > 1);
    expect(waits[1]).toBe(POLL_INTERVAL_WEBHOOK_MS);

    clock = NOW + WEBHOOK_HEALTHY_MS;
    gate.release?.();
    await waitFor(() => waits.length > 2);
    expect(waits[2]).toBe(POLL_INTERVAL_ACTIVE_MS);
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("waits 5 minutes while the remembered request budget is under 20%", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const waits: number[] = [];
    const gate = hold();
    let clock = NOW;
    const budget = rateBudget({
      requestsRemaining: 100,
      requestsLimit: 1_000,
      requestsResetMs: NOW + 600_000,
    });
    const poller = startCatchUpPoller({
      source: {
        async poll() {
          return {
            sessions: [],
            issues: [],
            comments: [],
            activities: [],
            budget,
            caughtUp: true,
            queried: true,
          };
        },
      },
      store,
      onEvent: () => {},
      hot: () => false,
      sleeper: recordingSleeper(waits, gate),
      now: () => clock,
      mono: () => clock - NOW,
    });
    await waitFor(() => waits.length > 0);
    expect(poller.budget()).toEqual(budget);
    expect(waits[0]).toBe(POLL_INTERVAL_LOW_BUDGET_MS);

    clock = NOW + 600_000;
    gate.release?.();
    await waitFor(() => waits.length > 1);
    expect(waits[1]).toBe(POLL_INTERVAL_IDLE_MS);
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("picks up a labeled issue and a delegated issue within one tick", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const seen: string[] = [];
    let polls = 0;
    const { client } = scripted(({ query }) => {
      expect(query).toContain("IntakePoll");
      polls += 1;
      return page([
        issue("iss_label", "ENG-9", ["paws"], null),
        issue("iss_delegate", "ENG-8", [], "app_1"),
        issue("iss_other", "ENG-7", ["bug"], "someone"),
      ]);
    });
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store,
      onEvent: (event) => {
        seen.push(event.issueId ?? "");
      },
      hot: () => false,
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => seen.length === 2);
    expect(polls).toBe(1);
    expect(seen.sort()).toEqual(["iss_delegate", "iss_label"]);
    expect(store.getCursor("linear")).toBe(NOW);
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("a labeled parent with three sub-issues keeps blocks order", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const { client } = scripted(({ query }) => {
      if (query.includes("IntakePoll")) {
        return page([issue("parent", "ENG-1", ["paws"], null)]);
      }
      if (query.includes("IssueSnapshot")) return snapshotPage();
      return relationsPage();
    });
    const tracker = createLinearTracker(client);
    let identifiers: string[] = [];
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store,
      db,
      onEvent: async (event) => {
        if (event.action !== "created" || event.issueId === null) return;
        const result = await intakeDelegatedIssue(db, tracker, {
          linearIssueId: event.issueId,
          sessionId: event.sessionId,
        });
        if (result.ok) identifiers = result.items.map((item) => item.linearIdentifier);
      },
      hot: () => false,
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => identifiers.length === 3);
    expect(identifiers).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("a duplicate page is processed once and the cursor survives restart", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const seen: string[] = [];
    const sinces: string[] = [];
    const labeled = issue("iss_dup", "ENG-1", ["Paws"], null);
    const fetchPage = ({ variables }: { variables: Record<string, unknown> }) => {
      sinces.push(String(variables["since"]));
      return page([labeled, labeled]);
    };
    const first = scripted(fetchPage);
    const poller = startCatchUpPoller({
      source: createIntakePollSource(first.client, { teamId: TEAM }),
      store,
      onEvent: (event) => {
        seen.push(event.dedupeKey);
      },
      hot: () => false,
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => seen.length === 1 && store.getCursor("linear") === NOW);
    await poller.stop();
    await poller.settled;

    const cursor = store.getCursor("linear");
    const second = scripted(fetchPage);
    const again = startCatchUpPoller({
      source: createIntakePollSource(second.client, { teamId: TEAM }),
      store,
      onEvent: (event) => {
        seen.push(event.dedupeKey);
      },
      hot: () => false,
      sleeper: blockedSleeper(),
      now: () => NOW,
    });
    await waitFor(() => sinces.length >= 2);
    const since = Date.parse(sinces[1] ?? "");
    expect(cursor).toBe(NOW);
    expect(since).toBeLessThanOrEqual(cursor ?? 0);
    expect((cursor ?? 0) - since).toBeLessThanOrEqual(5_000);
    expect(seen).toEqual(["issue:iss_dup:intake"]);
    const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox_event").get();
    expect(rows?.n).toBe(1);
    await again.stop();
    await again.settled;
    db.close();
  });

  test("RATELIMITED backs off, keeps the cursor, and resumes", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const seen: string[] = [];
    let calls = 0;
    const { client } = scripted(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            errors: [
              {
                message: "Rate limit exceeded",
                extensions: {
                  code: "RATELIMITED",
                  meta: { rateLimitResult: { reset: NOW + 30_000 } },
                },
              },
            ],
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
              "x-complexity": "80",
              "x-ratelimit-requests-remaining": "0",
              "x-ratelimit-complexity-remaining": "0",
            },
          },
        );
      }
      return json(page([issue("iss_later", "ENG-5", ["paws"], null)]), {
        "x-complexity": "12",
        "x-ratelimit-requests-remaining": "1490",
        "x-ratelimit-complexity-remaining": "240000",
      });
    });
    const waits: number[] = [];
    const gate = hold();
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store,
      onEvent: (event) => {
        seen.push(event.issueId ?? "");
      },
      hot: () => false,
      sleeper: recordingSleeper(waits, gate),
      now: () => NOW,
    });
    await waitFor(() => waits.length > 0);
    expect(seen).toEqual([]);
    expect(store.getCursor("linear")).toBeNull();
    expect(waits[0]).toBeGreaterThanOrEqual(30_000);
    expect(poller.budget()).toMatchObject({
      complexity: 80,
      requestsRemaining: 0,
      complexityRemaining: 0,
    });
    expect(linearBudget(client)?.complexity).toBe(80);
    gate.release?.();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(["iss_later"]);
    expect(poller.budget()).toMatchObject({ complexity: 12, requestsRemaining: 1490 });
    expect(store.getCursor("linear")).toBe(NOW);
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("label removal, /paws stop, and an agent stop submit stop commands", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const commands: { type: string; itemId: string }[] = [];
    let tick = 0;
    const { client } = scripted(({ query }) => {
      if (!query.includes("IntakePoll")) {
        if (query.includes("IssueSnapshot")) return loneSnapshot();
        return { issue: emptyRelations() };
      }
      tick += 1;
      if (tick === 1) return page([issue("iss_stop", "ENG-9", ["paws"], null)]);
      return page(
        [issue("iss_stop", "ENG-9", [], null)],
        [
          {
            id: "c_stop",
            body: "/paws stop",
            updatedAt: "2026-01-02T00:00:00.000Z",
            issue: { id: "iss_stop" },
          },
        ],
        [
          {
            id: "act_stop",
            updatedAt: "2026-01-02T00:00:01.000Z",
            signal: "stop",
            agentSession: { id: "ses_stop", issue: { id: "iss_stop" } },
            content: { __typename: "AgentActivityPromptContent", body: "halt", type: "prompt" },
          },
        ],
      );
    });
    const tracker = createLinearTracker(client);
    const gate = hold();
    const waits: number[] = [];
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: TEAM }),
      store,
      db,
      onEvent: async (event) => {
        if (event.action !== "created" || event.issueId === null) return;
        const result = await intakeDelegatedIssue(db, tracker, { linearIssueId: event.issueId });
        if (result.ok)
          for (const item of result.items)
            configureWorkItem(db, item.id, { sessionKey: "ses_stop" });
      },
      submitCommand: (command) => {
        commands.push({ type: command.type, itemId: command.itemId });
      },
      hot: () => false,
      sleeper: recordingSleeper(waits, gate),
      now: () => NOW,
    });
    await waitFor(() => waits.length > 0);
    expect(commands).toEqual([]);
    gate.release?.();
    await waitFor(() => commands.length === 3);
    expect(commands.every((command) => command.type === "stop")).toBe(true);
    const item = db
      .query<{ id: string }, []>("SELECT id FROM work_item WHERE linear_issue_id = 'iss_stop'")
      .get();
    if (item === null) throw new Error("missing work item");
    expect(commands.some((command) => command.itemId === item.id)).toBe(true);
    expect(new Set(commands.map((command) => command.itemId))).toEqual(new Set([item.id]));
    await poller.stop();
    await poller.settled;
    db.close();
  });

  test("an open question counts as active work", () => {
    const db = tempDb();
    expect(linearWorkIsHot(db)).toBe(false);
    db.run(
      `INSERT INTO question (
         id, item_id, session_id, body, status, created_at
       ) VALUES ('q1', 'item-1', 'ses', 'which?', 'open', 1)`,
    );
    expect(linearWorkIsHot(db)).toBe(true);
    db.run("UPDATE question SET status = 'answered' WHERE id = 'q1'");
    expect(linearWorkIsHot(db)).toBe(false);
    db.close();
  });

  test("the default config does not start a tunnel", async () => {
    const home = tempHome();
    const secrets = join(home, "secrets");
    mkdirSync(secrets, { recursive: true });
    const db = tempDb();
    const spawned: string[][] = [];
    const linear = openLinear({
      db,
      secretsDir: secrets,
      env: {
        LINEAR_ACCESS_TOKEN: "token",
        LINEAR_TEAM_ID: TEAM,
      },
      publicUrl: "https://demo.ngrok-free.app",
      fetch: async () => json(emptyData()),
      spawn: (command, args) => {
        spawned.push([command, ...args]);
        return { kill() {}, exited: new Promise(() => {}) };
      },
    });
    const running = linear.start(8787);
    await Bun.sleep(20);
    expect(running.tunnelRequested).toBe(false);
    expect(running.tunnelUp()).toBe(false);
    expect(spawned).toEqual([]);
    await running.stop();
    db.close();
  });

  test("LINEAR_WEBHOOKS starts ngrok with the dev-domain url", async () => {
    const home = tempHome();
    const secrets = join(home, "secrets");
    mkdirSync(secrets, { recursive: true });
    const db = tempDb();
    const spawned: string[][] = [];
    const linear = openLinear({
      db,
      secretsDir: secrets,
      env: {
        LINEAR_ACCESS_TOKEN: "token",
        LINEAR_TEAM_ID: TEAM,
        LINEAR_WEBHOOKS: "true",
        NGROK_AUTHTOKEN: "token-1",
      },
      publicUrl: "https://demo.ngrok-free.app",
      fetch: async () => json(emptyData()),
      spawn: (command, args, options) => {
        spawned.push([command, ...args]);
        expect(options.env["NGROK_AUTHTOKEN"]).toBe("token-1");
        expect([command, ...args].join(" ")).not.toContain("token-1");
        return { kill() {}, exited: new Promise(() => {}) };
      },
    });
    const running = linear.start(8787);
    expect(running.tunnelRequested).toBe(true);
    expect(spawned).toEqual([["ngrok", "http", "--url=https://demo.ngrok-free.app", "8787"]]);
    await running.stop();
    db.close();
  });
});

function emptyPage(): unknown {
  return emptyData();
}

function emptyData(): Record<string, unknown> {
  return {
    viewer: { id: "app_1" },
    issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    agentActivities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

function page(
  issues: Record<string, unknown>[],
  comments: Record<string, unknown>[] = [],
  activities: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    viewer: { id: "app_1" },
    issues: { nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } },
    comments: { nodes: comments, pageInfo: { hasNextPage: false, endCursor: null } },
    agentActivities: { nodes: activities, pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

function issue(
  id: string,
  identifier: string,
  labels: string[],
  delegate: string | null,
): Record<string, unknown> {
  return {
    id,
    identifier,
    updatedAt: "2026-01-01T00:00:00.000Z",
    delegate: delegate === null ? null : { id: delegate },
    labels: { nodes: labels.map((name) => ({ name })) },
  };
}

function session(id: string, issueId: string, createdAt: number): Record<string, unknown> {
  return {
    id,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
    appUser: { id: "app_1" },
    issue: { id: issueId, team: { id: TEAM, key: "ENG" } },
  };
}

function snapshotPage(): Record<string, unknown> {
  return {
    issue: {
      id: "parent",
      identifier: "ENG-1",
      title: "Add CSV export",
      description: null,
      children: {
        nodes: [
          { id: "c", identifier: "ENG-4", title: "decision", subIssueSortOrder: 3 },
          { id: "a", identifier: "ENG-2", title: "export endpoint", subIssueSortOrder: 1 },
          { id: "b", identifier: "ENG-3", title: "same file", subIssueSortOrder: 2 },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function relationsPage(): Record<string, unknown> {
  return {
    issue: {
      id: "parent",
      relations: {
        nodes: [{ type: "blocks", issue: { id: "a" }, relatedIssue: { id: "b" } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

function loneSnapshot(): Record<string, unknown> {
  return {
    issue: {
      id: "iss_stop",
      identifier: "ENG-9",
      title: "Fix the header",
      description: null,
      children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

function emptyRelations(): Record<string, unknown> {
  return {
    id: "iss_stop",
    relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

const AUTH: LinearAuth = {
  hasToken: () => true,
  ensureFresh: async () => "token",
  forceRefresh: async () => "token",
};

function scripted(
  handler: (input: { query: string; variables: Record<string, unknown> }) => unknown,
): { client: ReturnType<typeof createLinearClient> } {
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const result = handler(body);
    if (result instanceof Response) return result;
    return json(result);
  };
  return { client: createLinearClient({ auth: AUTH, fetch: fetchImpl }) };
}

function sourceFrom(handler: () => Promise<unknown>) {
  return createIntakePollSource(
    {
      async query() {
        return handler();
      },
    },
    { teamId: TEAM },
  );
}

function json(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rateBudget(overrides: Partial<LinearRateBudget>): LinearRateBudget {
  return {
    requestsRemaining: null,
    requestsLimit: null,
    requestsResetMs: null,
    complexityRemaining: null,
    complexityLimit: null,
    complexityResetMs: null,
    complexity: null,
    ...overrides,
  };
}

function hold(): { release: (() => void) | null } {
  return { release: null };
}

function recordingSleeper(waits: number[], gate: { release: (() => void) | null }): Sleeper {
  return {
    wait(ms) {
      waits.push(ms);
      return new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    },
    wake() {
      gate.release?.();
      gate.release = null;
    },
  };
}

function blockedSleeper(): Sleeper {
  let resolveWait: (() => void) | null = null;
  return {
    wait: () =>
      new Promise((resolve) => {
        resolveWait = resolve;
      }),
    wake() {
      resolveWait?.();
      resolveWait = null;
    },
  };
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the poller");
    await Bun.sleep(10);
  }
}

test("stopping joins a manual Linear poll before its final SQLite write", async () => {
  const db = tempDb();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let polls = 0;
  const store = createInboxStore(db);
  const poller = startCatchUpPoller({
    db,
    store,
    onEvent() {},
    sleeper: blockedSleeper(),
    source: {
      async poll() {
        if (++polls === 2) {
          ready.resolve();
          await release.promise;
        }
        return {
          sessions: [],
          issues: [],
          comments: [],
          activities: [],
          budget: null,
          caughtUp: true,
          queried: true,
        };
      },
    },
  });
  try {
    await waitFor(() => polls === 1 && store.getCursor("linear") !== null);
    const manual = poller.pollNow();
    await ready.promise;
    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    expect(store.getCursor("linear")).toBeNumber();
    release.resolve();
    await stopping;
    await manual;
    expect(stopped).toBe(true);
    await poller.pollNow();
    expect(polls).toBe(2);
  } finally {
    release.resolve();
    await poller.stop();
    db.close();
  }
});

test("Linear runtime stop joins interrupted events and rejects new handlers before SQLite closes", async () => {
  const db = tempDb();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const linear = openLinear({
    db,
    secretsDir: join(tempHome(), "secrets"),
    env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
    publicUrl: null,
    fetch: async () => json(emptyData()),
    followUp: async () => {
      ready.resolve();
      await release.promise;
      db.run("UPDATE inbox_event SET handled = 1 WHERE dedupe_key = 'accepted'");
    },
  });
  const running = linear.start(0);
  const event: AcceptedLinearEvent = {
    dedupeKey: "accepted",
    deliveryId: null,
    source: "webhook",
    action: "prompted",
    sessionId: "session",
    issueId: "issue",
    activityId: "activity",
    body: "Request",
    signal: null,
    updatedAtMs: 1,
    payload: "{}",
  };
  linear.webhook.store.commit(event);
  const accepted = Promise.resolve(linear.webhook.onEvent!(event)).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await ready.promise;
    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    await expect(
      Promise.resolve(linear.webhook.onEvent!({ ...event, dedupeKey: "new" })),
    ).rejects.toThrow("shutting down");
    release.resolve();
    expect(await accepted).toMatchObject({ name: "AbortError" });
    await stopping;
    expect(stopped).toBe(true);
    expect(linear.webhook.store.listUnhandled()).toEqual([]);
  } finally {
    release.resolve();
    await accepted;
    await running.stop();
    db.close();
  }
});

test("a synchronous Linear adapter Stop joins the poll before SQLite can close", async () => {
  const db = tempDb();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = createInboxStore(db);
  let polls = 0;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const poller = startCatchUpPoller({
    db,
    store,
    onEvent() {},
    sleeper: blockedSleeper(),
    source: {
      async poll() {
        if (++polls === 2) {
          stopping = poller.stop().then(() => {
            stopped = true;
          });
          ready.resolve();
          await release.promise;
        }
        return {
          sessions: [],
          issues: [],
          comments: [],
          activities: [],
          budget: null,
          caughtUp: true,
          queried: true,
        };
      },
    },
  });
  let manual: Promise<void> | undefined;
  try {
    await waitFor(() => polls === 1 && store.getCursor("linear") !== null);
    manual = poller.pollNow();
    await ready.promise;
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    await manual;
    expect(stopped).toBe(true);
    expect(store.getCursor("linear")).toBeNumber();
  } finally {
    release.resolve();
    await manual;
    await poller.stop();
    db.close();
  }
});

test("the catch-up poll ignores activities Paws posted itself", async () => {
  const { client } = scripted(() =>
    page(
      [],
      [],
      [
        {
          id: "act_thought",
          updatedAt: "2026-01-02T00:00:00.000Z",
          user: { id: "app_1" },
          agentSession: { id: "ses_1", issue: { id: "iss_1" } },
          content: { __typename: "AgentActivityThoughtContent" },
        },
        {
          id: "act_prompt",
          updatedAt: "2026-01-02T00:00:01.000Z",
          user: { id: "user_1" },
          agentSession: { id: "ses_1", issue: { id: "iss_1" } },
          content: { __typename: "AgentActivityPromptContent", body: "go on", type: "prompt" },
        },
      ],
    ),
  );
  const sighting = await createIntakePollSource(client, { teamId: TEAM }).poll(0);
  expect(sighting.activities.map((activity) => activity.id)).toEqual(["act_prompt"]);
});
