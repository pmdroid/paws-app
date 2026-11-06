import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRetro, insertQueuedItem, listImprovementDeliveries, retroArtifact } from "../src/db";
import {
  deliverImprovements,
  syncImprovementOutcomes,
  type StartIssueSession,
} from "../src/improvements";
import { createFakeImprovementLinear } from "../src/linear";
import { createRetroReviewHttp } from "../src/retros";
import {
  parseAttention,
  parseFollowThrough,
  parseImprovementDetail,
  parseImprovementList,
  parseRetroHistory,
  parseRetroReport,
} from "../src/dashboard/src/improvements";
type Node = {
  value: string;
  checked: boolean;
  scrollTop: number;
  textContent: string | null;
  click(): void;
  focus(): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  dispatchEvent(event: unknown): boolean;
  requestSubmit(submitter?: Node): void;
  querySelector(selector: string): Node | null;
};
type Route = { view: string; tab?: string; id: string | null };
const client = (path: string) => import(path);
const { createImprovements } = await client("../src/dashboard/src/client/improvements-page.ts");
const { matchRoute, retroRedirect, routePath } = (await client(
  "../src/dashboard/src/client/route.ts",
)) as {
  matchRoute(path: string): Route | null;
  retroRedirect(path: string): string | null;
  routePath(route: Route): string;
};
import {
  ALL,
  END,
  ONLY_A,
  START,
  accept,
  seedDaily,
  world,
  type Json,
} from "./improvement-fixtures";
import { rmSync } from "node:fs";
import { join } from "node:path";

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Event",
  "SubmitEvent",
  "CSS",
  "FormData",
  "location",
] as const;
const saved = new Map<string, unknown>();
let window: Window;

beforeEach(() => {
  window = new Window({ url: "http://paws.test/dashboard/improvements" });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] =
      name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
  }
});

afterEach(async () => {
  for (const name of DOM_GLOBALS) (globalThis as Record<string, unknown>)[name] = saved.get(name);
  await window.happyDOM.close();
});

const MERGE = "c0ffee1234567890c0ffee1234567890c0ffee12";
const SCHEDULE = {
  saved: true,
  settingsRevision: 1,
  schedule: { weekday: "monday", time: "09:00", timeZone: "UTC" },
  state: "ready",
  reason: null,
  nextRun: { at: END + 7 * 86_400_000, due: false },
  retry: null,
  blocked: null,
  lastSuccess: {
    retroId: "r1",
    cutoff: END,
    windowStart: END - 7 * 86_400_000,
    publishedAt: END,
    empty: false,
  },
  current: null,
  canEdit: false,
  canRun: true,
};

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness() {
  const linear = createFakeImprovementLinear();
  const starts: string[] = [];
  const startSession: StartIssueSession = async (target) => {
    starts.push(target.id);
    return { id: `session-${starts.length}`, url: null };
  };
  const w = world({ linear, startSession, dashboardUrl: "https://paws.test/" });
  seedDaily(w.db);
  const retros = createRetroReviewHttp({ db: w.db, artifactRoot: w.root, now: w.now });
  const requests: { method: string; path: string }[] = [];
  const holds: { path: string; release: () => void }[] = [];
  let hold: RegExp | null = null;
  let who = "ada";
  const answers = new Map<string, () => Response>();
  const serve = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url));
    requests.push({ method: init?.method ?? "GET", path: `${target.pathname}${target.search}` });
    if (hold?.test(target.pathname)) {
      const gate = Promise.withResolvers<void>();
      holds.push({ path: target.pathname, release: gate.resolve });
      await gate.promise;
    }
    const request = new Request(target.toString(), {
      method: init?.method ?? "GET",
      ...(init?.body ? { body: init.body as string } : {}),
    });
    const answer = answers.get(target.pathname);
    if (answer) return answer();
    if (target.pathname === "/api/retros/schedule") return Response.json(SCHEDULE);
    if (target.pathname === "/api/retros/runs")
      return Response.json({ retroId: "r2", created: true, status: SCHEDULE }, { status: 202 });
    if (target.pathname === "/api/finding-groups")
      return Response.json({ groups: [], lastRun: null, canRun: false, enabled: true });
    const sessions = who === "admin" ? ALL : ONLY_A;
    const handled = target.pathname.startsWith("/api/retros/")
      ? await retros(request, w.people[who]!, sessions)
      : await w.improvements(request, w.people[who]!, sessions);
    return handled ?? Response.json({ error: "Not found." }, { status: 404 });
  };
  let tick = () => {};
  let search = "";
  const downloads: { name: string; text: string }[] = [];
  const counts: number[] = [];
  const went: Route[] = [];
  const page = createImprovements({
    counted: (total: number) => counts.push(total),
    go: (route: Route) => went.push(route),
    fetch: serve as typeof fetch,
    poll: (next: () => void) => {
      tick = next;
      return () => {
        tick = () => {};
      };
    },
    csrf: () => "token",
    paint: (root: { innerHTML: string }, html: string) => {
      root.innerHTML = html;
    },
    location: () => ({ pathname: "/dashboard/improvements", search }),
    replaceSearch: (next: string) => {
      search = next;
    },
    save: (blob: Blob, name: string) => {
      void blob.text().then((text) => downloads.push({ name, text }));
    },
  });
  const root = window.document.createElement("div");
  window.document.body.append(root);
  const open = async (path: string) => {
    const [pathname, query = ""] = path.split("?");
    search = query ? `?${query}` : "";
    const route = matchRoute(pathname!);
    if (route?.view !== "improvements") throw new Error(`not an improvements route: ${path}`);
    page.mount(root, "http://paws.test", route, "ada@ws");
    await settle();
  };
  const find = (selector: string): Node => {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`missing ${selector} in:\n${root.textContent}`);
    return element as unknown as Node;
  };
  const click = async (selector: string) => {
    find(selector).click();
    await settle();
  };
  const type = (selector: string, value: string) => {
    const input = find(selector);
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const submit = async (selector: string, submitter?: string) => {
    const form = find(selector);
    form.requestSubmit(submitter ? form.querySelector(submitter)! : undefined);
    await settle();
  };
  const deliver = (now = END + 60 * 60_000) =>
    deliverImprovements({
      db: w.db,
      owner: "test",
      linearFor: async () => linear,
      sourceUrl: (id) => `https://paws.test/dashboard/improvements/${id}`,
      now: () => now,
    });
  const sync = () =>
    syncImprovementOutcomes({ db: w.db, linearFor: async () => linear, now: w.now });
  return {
    w,
    linear,
    starts,
    root,
    page,
    requests,
    saved: downloads,
    counts,
    went,
    answers,
    holds,
    holdOn(pattern: RegExp | null) {
      hold = pattern;
    },
    as(name: string) {
      who = name;
    },
    open,
    find,
    click,
    type,
    submit,
    deliver,
    sync,
    poll: async () => {
      tick();
      await settle();
    },
    text: () => root.textContent ?? "",
  };
}

describe("improvement routes", () => {
  test("review, item, report, history and settings paths round-trip", () => {
    for (const path of [
      "/improvements",
      "/improvements/01JIMPROVEMENT",
      "/improvements/reports/r1",
      "/improvements/history",
      "/improvements/settings",
    ])
      expect(routePath(matchRoute(path)!)).toBe(path);
    expect(matchRoute("/improvements/reports")).toBeNull();
    expect(matchRoute("/improvements/a/b")).toBeNull();
  });

  test("old retro links land on the inbox and the report", () => {
    expect(retroRedirect("/retros")).toBe("/improvements?source=weekly");
    expect(retroRedirect("/retros/r1")).toBe("/improvements/reports/r1");
    expect(retroRedirect("/findings")).toBeNull();
  });
});

describe("improvement inbox contract", () => {
  test("the page parses what the improvement and retro routes answer", async () => {
    const t = harness();
    const id = t.w.retro.a;
    const read = async (path: string) => (await t.w.api("ada", path)).body;
    expect(parseImprovementList(await read("/api/improvements")).ok).toBe(true);
    expect(parseImprovementDetail(await read(`/api/improvements/${id}`)).ok).toBe(true);
    expect(parseFollowThrough(await read(`/api/improvements/${id}/follow-through`)).ok).toBe(true);
    expect(parseAttention(await read("/api/improvements/attention")).ok).toBe(true);
    const retros = createRetroReviewHttp({ db: t.w.db, artifactRoot: t.w.root });
    const retro = async (path: string) =>
      (await retros(new Request(`http://paws.test${path}`), t.w.people.ada!, ONLY_A))!.json();
    expect(parseRetroHistory(await retro("/api/retros/history")).ok).toBe(true);
    expect(parseRetroReport(await retro("/api/retros/reports/r1")).ok).toBe(true);
    expect(parseImprovementList({ items: [{ id: 1 }], counts: {} }).ok).toBe(false);
  });
});

describe("improvement inbox", () => {
  test("a daily finding filed from Findings is read-only: no decision, delegation or follow-through", async () => {
    const t = harness();
    const daily = (await t.w.api("ada", "/api/improvements?source=daily")).body.items[0]
      .id as string;
    t.w.db.run("UPDATE finding_group SET status = 'filed', filed_issue = 'PAS-77'");
    await t.open(`/improvements/${daily}`);
    expect(t.text()).toContain("Handled in Findings");
    expect(t.text()).toContain("PAS-77");
    const detail = t.find("[data-improvement]").textContent ?? "";
    expect(detail).not.toContain("Needs review");
    expect(detail).not.toContain("Accepting");
    for (const selector of [
      "[data-improvement-choice]",
      "[data-improvement-form]",
      '[data-improvement-action="delegate"]',
      '[data-improvement-action="reopen"]',
      '[data-improvement-action="use-issue"]',
    ])
      expect(t.root.querySelector(selector)).toBeNull();
    expect(t.find(`a[href="/dashboard/findings"]`)).toBeTruthy();
    const row = t.find(`[data-improvement-row="${daily}"]`);
    expect(row.textContent).toContain("Handled in Findings");
    await t.poll();
    expect(t.requests.filter((r) => r.method === "POST")).toEqual([]);
    const attention = (await t.w.api("ada", "/api/improvements/attention")).body;
    expect(attention.counts.newReview).toBe(1);
    expect(attention.items.find((i: { id: string }) => i.id === daily).attention).toBe("closed");
  });

  test("a daily finding dismissed from Findings shows no review attention and cannot be reopened here", async () => {
    const t = harness();
    const daily = (await t.w.api("ada", "/api/improvements?source=daily")).body.items[0]
      .id as string;
    t.w.db.run("UPDATE finding_group SET status = 'dismissed', status_reason = 'Noise'");
    await t.open(`/improvements/${daily}`);
    const detail = t.find("[data-improvement]").textContent ?? "";
    expect(detail).toContain("Dismissed from Findings");
    expect(detail).not.toContain("Needs review");
    expect(t.root.querySelector('[data-improvement-action="reopen"]')).toBeNull();
    expect(t.root.querySelector("[data-improvement-form]")).toBeNull();
  });

  test("lists both sources once each, with filters, and keeps the report capped at five", async () => {
    const t = harness();
    await t.open("/improvements");
    const rows = [...t.root.querySelectorAll("[data-improvement-row]")].map((row) =>
      row.getAttribute("data-improvement-row"),
    );
    expect(new Set(rows).size).toBe(rows.length);
    expect(t.text()).toContain("Daily finding");
    expect(t.text()).toContain("Weekly retro");
    expect(t.requests.some((r) => r.path.startsWith("/api/status"))).toBe(false);

    const source = t.find('[data-improvement-filter="source"]');
    source.value = "weekly";
    source.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    const shown = [...t.root.querySelectorAll("[data-improvement-row]")].map(
      (row) => row.textContent,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Weekly retro");
    expect(t.requests.at(-1)?.path).toContain("source=weekly");

    await t.open("/improvements/reports/r1");
    expect(t.text()).toContain("of at most 5");
    expect(t.text()).toContain("Frozen when the retro ran");
  });

  test("report source → one issue → explicit delegation → merged awaiting verification → verified", async () => {
    const t = harness();
    const id = t.w.retro.a;
    await t.open(`/improvements/${id}?source=weekly`);
    expect(t.find('[data-improvement-choice="create"]').getAttribute("aria-pressed")).toBe("true");
    expect(t.text()).toContain("Paws files one issue in this team");

    t.holdOn(/\/decision$/);
    t.find('[data-improvement-form="create"] button[type="submit"]').click();
    await settle();
    t.find('[data-improvement-form="create"] button[type="submit"]').click();
    await settle();
    expect(t.holds).toHaveLength(1);
    expect(
      t.find('[data-improvement-form="create"] button[type="submit"]').hasAttribute("disabled"),
    ).toBe(true);
    t.holdOn(null);
    t.holds[0]!.release();
    await settle();
    expect(t.text()).toContain("Accepted. Paws files the issue");
    expect(t.text()).toContain("Filing");

    t.linear.fail("createIssue", "lose");
    await t.deliver();
    await t.poll();
    expect(t.text()).toContain("Checking with Linear");
    expect(t.text()).toContain("never files a second issue");
    expect(t.text()).toContain("Accepted");

    await t.deliver(END + 24 * 60 * 60_000);
    await t.poll();
    expect(t.linear.created).toHaveLength(1);
    expect(t.text()).toContain("IMP-1");
    expect(t.text()).toContain("Delegate to Paws");
    expect(t.starts).toEqual([]);

    await t.click('[data-improvement-action="delegate"]');
    expect(t.starts).toHaveLength(1);
    expect(t.root.querySelector('[data-improvement-action="delegate"]')).toBeNull();

    const issueId = listImprovementDeliveries(t.w.db, id)[0]!.remoteId!;
    insertQueuedItem(t.w.db, { id: "work-x", sessionKey: "session-a", now: END + 2_500 });
    t.w.db.run("UPDATE work_item SET linear_issue_id = ?, state = 'running' WHERE id = 'work-x'", [
      issueId,
    ]);
    await t.sync();
    await t.poll();
    expect(t.text()).toContain("Working");

    t.w.db.run("UPDATE work_item SET state = 'merged' WHERE id = 'work-x'");
    t.w.db.run("INSERT INTO item_pull_request VALUES ('work-x', 42, 'https://gh/pull/42', ?)", [
      END,
    ]);
    t.w.db.run(
      "INSERT INTO remote_merge_fact VALUES ('work-x', 'acme', 'a', 42, 'https://gh/pull/42', ?, ?)",
      [MERGE, END + 3_000],
    );
    await t.sync();
    await t.poll();
    expect(t.text()).toContain("Merged · awaiting verification");
    expect(t.text()).toContain("does not prove the change is deployed");
    expect(t.find('[data-improvement-draft="revision"]').value).toBe(MERGE);

    t.type('[data-improvement-draft="check"]', "Weekly retro push-recovery questions");
    t.type('[data-improvement-draft="result"]', "None in the two retros after the merge.");
    t.type('[data-improvement-draft="url"]', "https://linear.app/x/retro");
    await t.poll();
    expect(t.find('[data-improvement-draft="check"]').value).toBe(
      "Weekly retro push-recovery questions",
    );
    await t.submit('[data-improvement-form="verification"]');
    expect(t.text()).toContain("Verification recorded.");
    expect(t.text()).toContain("Verified");
    const history = t.find(".improvement-history");
    expect(history.textContent).toContain("Weekly retro push-recovery questions");
    expect(history.textContent).toContain("None in the two retros after the merge.");
    expect(history.textContent).toContain(MERGE);
    expect(history.querySelector('a[href="https://linear.app/x/retro"]')).toBeTruthy();
    expect(t.starts).toHaveLength(1);
  });

  test("a daily finding links known work by default and can add an evidence comment", async () => {
    const t = harness();
    const retroAccept = await t.w.api("ada", `/api/improvements/${t.w.retro.a}/decision`, {
      expectedVersion: 1,
      decision: { kind: "accept", proposalVersion: 1, intent: { kind: "link", issue: "PAS-60" } },
    });
    expect(retroAccept.body.status).toBe("decided");
    t.linear.issues.set("issue-open", {
      id: "issue-open",
      identifier: "PAS-60",
      url: "https://linear.app/x/PAS-60",
      teamId: "team-a",
      state: "open",
      delegated: false,
    });
    await t.deliver();
    const list = await t.w.api("ada", "/api/improvements?source=daily");
    const daily = list.body.items[0].id as string;
    await t.open(`/improvements/${daily}`);
    expect(t.find('[data-improvement-choice="link"]').getAttribute("aria-pressed")).toBe("true");
    expect(t.find('[data-improvement-draft="issue"]').value).toBe("PAS-60");
    expect(t.text()).toContain("posts nothing to it");
    const comment = t.find('[data-improvement-draft="comment"]');
    comment.checked = true;
    comment.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    expect(t.text()).toContain("Link and add evidence");
    t.type('[data-improvement-draft="criterion"]', "No timing finding in src/a.ts for a week.");
    await t.submit('[data-improvement-form="link"]');
    expect(t.text()).toContain("Accepted. Paws confirms the link");
    expect(
      listImprovementDeliveries(t.w.db, daily)
        .map((d) => d.operation)
        .sort(),
    ).toEqual(["evidence_comment", "link_issue"]);
  });

  test("reject asks for a reason, files nothing and stays in history", async () => {
    const t = harness();
    const id = t.w.retro.a;
    await t.open(`/improvements/${id}`);
    await t.click('[data-improvement-choice="reject"]');
    expect(t.find('[data-improvement-draft="reason"]').hasAttribute("required")).toBe(true);
    t.type('[data-improvement-draft="reason"]', "Tracked in the runbook");
    await t.submit('[data-improvement-form="reject"]');
    expect(t.text()).toContain("Rejected by");
    expect(t.text()).toContain("No issue was filed");
    expect(listImprovementDeliveries(t.w.db, id)).toEqual([]);
  });

  test("a decision from another tab answers stale and shows the current state", async () => {
    const t = harness();
    const id = t.w.retro.a;
    await t.open(`/improvements/${id}`);
    const other = await t.w.api("bea", `/api/improvements/${id}/decision`, {
      expectedVersion: 1,
      decision: { kind: "reject", reason: "Covered by PAS-60" },
    });
    expect(other.body.status).toBe("decided");
    await t.submit('[data-improvement-form="create"]');
    expect(t.text()).toContain("Someone changed this improvement after you opened it");
    expect(t.text()).toContain("Covered by PAS-60");
    expect(listImprovementDeliveries(t.w.db, id)).toEqual([]);
  });

  test("late answers for an earlier selection, page or version are dropped", async () => {
    const t = harness();
    const [a, daily] = [
      t.w.retro.a,
      (await t.w.api("ada", "/api/improvements?source=daily")).body.items[0].id,
    ];
    await t.open(`/improvements/${a}`);
    t.holdOn(new RegExp(`/api/improvements/${daily}`));
    await t.open(`/improvements/${daily}`);
    t.holdOn(null);
    await t.open(`/improvements/${a}`);
    for (const held of t.holds) held.release();
    await settle();
    expect(t.find("[data-improvement]").getAttribute("data-improvement")).toBe(a);

    t.holdOn(/\/api\/improvements\/[^/]+$/);
    await t.poll();
    t.holdOn(null);
    const decided = await t.w.api("ada", `/api/improvements/${a}/decision`, {
      expectedVersion: 1,
      decision: { kind: "reject", reason: "Not recurring" },
    });
    expect(decided.body.status).toBe("decided");
    await t.poll();
    expect(t.text()).toContain("Rejected by");
    for (const held of t.holds.splice(0)) held.release();
    await settle();
    expect(t.text()).toContain("Rejected by");
    expect(t.text()).not.toContain("Create issue");
  });

  test("selection, evidence expansion and the list scroll survive polling; phone back keeps filters", async () => {
    const t = harness();
    const id = t.w.retro.a;
    await t.open(`/improvements/${id}?source=weekly`);
    const back = t.find("[data-improvement-back]");
    expect(back.getAttribute("href")).toBe("/dashboard/improvements?source=weekly");
    expect(t.find("[data-improvement-row]").getAttribute("aria-current")).toBe("true");
    const pane = t.find('[data-scroll-key="list"]');
    pane.scrollTop = 40;
    await t.click('[data-improvement-choice="reject"]');
    t.type('[data-improvement-draft="reason"]', "Half typed");
    await t.poll();
    expect(t.find('[data-improvement-draft="reason"]').value).toBe("Half typed");
    expect(t.find('[data-scroll-key="list"]').scrollTop).toBe(pane.scrollTop);
    expect(t.find("[data-improvement-row]").getAttribute("aria-current")).toBe("true");
    await t.open("/improvements?source=weekly");
    expect(t.find("[data-improvement-row]").getAttribute("aria-current")).toBeNull();
    expect(t.requests.filter((r) => r.path.includes("/evidence")).length).toBe(0);
  });

  test("a missing item, a missing report and a lost permission explain themselves", async () => {
    const t = harness();
    await t.open("/improvements/01UNKNOWNIMPROVEMENT");
    expect(t.text()).toContain("not in your inbox");
    await t.open("/improvements/reports/nope");
    expect(t.text()).toContain("Retro not available");
    expect(t.text()).toContain("Return to the history");
    await t.open("/improvements");
    t.w.db.run("UPDATE workspace_member SET active = 0 WHERE user_id = 'user-ada'");
    await t.poll();
    expect(t.text()).toContain("Your workspace access changed");
    expect(t.text()).toContain("Showing the last list Paws read");
  });

  test("the navigation count clears on lost access and drops a late answer for an earlier reader", async () => {
    const t = harness();
    await t.open("/improvements");
    expect(t.counts.at(-1)).toBe(2);
    t.w.db.run("UPDATE workspace_member SET active = 0 WHERE user_id = 'user-ada'");
    await t.poll();
    expect(t.counts.at(-1)).toBe(0);
    t.w.db.run("UPDATE workspace_member SET active = 1 WHERE user_id = 'user-ada'");
    t.holdOn(/\/attention$/);
    const late = t.page.refreshCount("http://paws.test");
    await settle();
    t.page.resetCount();
    t.holdOn(null);
    for (const held of t.holds.splice(0)) held.release();
    await late;
    expect(t.counts.at(-1)).toBe(0);
  });

  test("retrying a failed generation opens the retro the run endpoint returns", async () => {
    const t = harness();
    await t.open("/improvements/reports/r1");
    const r1 = t.page.view().report;
    const failed = {
      ...r1,
      retro: {
        ...r1.retro,
        id: "r0",
        generation: { ...r1.retro.generation, state: "failed", error: "Runner lost" },
      },
      report: null,
    };
    t.answers.set("/api/retros/reports/r0", () => Response.json(failed));
    await t.open("/improvements/reports/r0");
    expect(t.text()).toContain("Runner lost");
    await t.click('[data-improvement-action="run-retro"]');
    expect(t.went).toEqual([{ view: "improvements", tab: "report", id: "r2" }]);
    expect(t.requests.filter((r) => r.path === "/api/retros/reports/r0")).toHaveLength(1);
    await t.open("/improvements/reports/r2");
    expect(t.text()).toContain("Retro requested");
  });

  test("a mutation answer after navigating away leaves the new item alone", async () => {
    const t = harness();
    const a = t.w.retro.a;
    const daily = (await t.w.api("ada", "/api/improvements?source=daily")).body.items[0].id;
    await t.open(`/improvements/${a}`);
    await t.click('[data-improvement-choice="reject"]');
    t.type('[data-improvement-draft="reason"]', "Not recurring");
    t.holdOn(/\/decision$/);
    await t.submit('[data-improvement-form="reject"]');
    expect(t.holds).toHaveLength(1);
    t.holdOn(null);
    await t.open(`/improvements/${daily}`);
    t.type('[data-improvement-draft="criterion"]', "Draft for the daily finding");
    t.holds[0]!.release();
    await settle();
    expect(t.find("[data-improvement]").getAttribute("data-improvement")).toBe(daily);
    expect(t.find('[data-improvement-draft="criterion"]').value).toBe(
      "Draft for the daily finding",
    );
    expect(t.text()).not.toContain("Rejected. It stays in history");
    expect(t.page.view().busy).toBeNull();
  });

  test("polling keeps every row Show more loaded and its next page", async () => {
    const t = harness();
    await t.open("/improvements");
    const full = t.page.view().list;
    const pages = [0, 1, 2].map((n) => ({
      ...full,
      items: Array.from({ length: 100 }, (_, i) => ({
        ...full.items[0],
        id: `item-${n * 100 + i}`,
      })),
      nextCursor: n < 2 ? `c${n + 1}` : null,
    }));
    t.page.view().list = {
      ...pages[0],
      items: [...pages[0]!.items, ...pages[1]!.items],
      nextCursor: "c2",
    };
    const listed = t.w.improvements;
    t.w.improvements = async (...args: Parameters<typeof listed>) => {
      const url = new URL(args[0].url);
      if (url.pathname !== "/api/improvements") return listed(...args);
      const cursor = url.searchParams.get("cursor");
      return Response.json(pages[cursor ? Number(cursor.slice(1)) : 0]);
    };
    await t.poll();
    expect(t.page.view().list.items).toHaveLength(200);
    expect(t.page.view().list.nextCursor).toBe("c2");
  });

  test("a mutation answer after leaving and returning to the item stays stale", async () => {
    const t = harness();
    const a = t.w.retro.a;
    const daily = (await t.w.api("ada", "/api/improvements?source=daily")).body.items[0].id;
    await t.open(`/improvements/${a}`);
    await t.click('[data-improvement-choice="reject"]');
    t.type('[data-improvement-draft="reason"]', "Not recurring");
    t.holdOn(/\/decision$/);
    await t.submit('[data-improvement-form="reject"]');
    expect(t.holds).toHaveLength(1);
    t.holdOn(null);
    await t.open(`/improvements/${daily}`);
    await t.open(`/improvements/${a}`);
    t.holds[0]!.release();
    await settle();
    expect(t.page.view().message).toBe("");
    expect(t.page.view().error).toBeNull();
    expect(t.page.view().busy).toBeNull();
  });

  test("Review polling picks up a schedule another tab changed", async () => {
    const t = harness();
    await t.open("/improvements");
    expect(t.page.view().schedule.state).toBe("ready");
    t.answers.set("/api/retros/schedule", () =>
      Response.json({ ...SCHEDULE, state: "running", current: null }),
    );
    await t.poll();
    expect(t.page.view().schedule.state).toBe("running");
  });

  test("history polling keeps every page Show more loaded", async () => {
    const t = harness();
    await t.open("/improvements/history");
    const entry = t.page.view().history.retros[0];
    const pages = [0, 1, 2].map((n) => ({
      retros: [0, 1].map((i) => ({
        ...entry,
        id: `r-${n}-${i}`,
        generation: { ...entry.generation, state: n === 0 && i === 0 ? "running" : "ready" },
      })),
      total: 6,
      nextCursor: n < 2 ? `c${n + 1}` : null,
    }));
    t.page.view().history = { ...pages[1], retros: [...pages[0]!.retros, ...pages[1]!.retros] };
    t.answers.set("/api/retros/history", () => {
      const cursor = new URL(`http://paws.test${t.requests.at(-1)!.path}`).searchParams.get(
        "cursor",
      );
      return Response.json(pages[cursor ? Number(cursor.slice(1)) : 0]);
    });
    await t.poll();
    expect(t.page.view().history.retros.map((r: { id: string }) => r.id)).toEqual([
      "r-0-0",
      "r-0-1",
      "r-1-0",
      "r-1-1",
    ]);
    expect(t.page.view().history.nextCursor).toBe("c2");
    await t.click('[data-improvement-action="more-history"]');
    expect(t.page.view().history.retros).toHaveLength(6);
    expect(t.page.view().history.nextCursor).toBeNull();
  });

  test("history lists the retro and the settings tab keeps daily and weekly controls apart", async () => {
    const t = harness();
    await t.open("/improvements/history");
    expect(t.text()).toContain("Each retro keeps its frozen report");
    expect(t.find('a[href="/dashboard/improvements/reports/r1"]')).toBeTruthy();
    await t.open("/improvements/settings");
    expect(t.text()).toContain("Daily grouping keeps its own settings");
    expect(t.text()).toContain("A manual retro uses the same saved settings");
    await t.click('[data-improvement-action="run-retro"]');
    expect(t.text()).toContain("Retro requested");
  });
});

const DAY = 86_400_000;

/** Ada accepts the acme/a pattern, Paws files IMP-1, and work on it reaches `state`. */
async function filedWork(t: ReturnType<typeof harness>, state: string) {
  const id = t.w.retro.a;
  expect((await t.w.api("ada", `/api/improvements/${id}/decision`, accept())).status).toBe(200);
  await t.deliver();
  const issueId = listImprovementDeliveries(t.w.db, id)[0]!.remoteId!;
  insertQueuedItem(t.w.db, { id: "work-x", sessionKey: "session-a", now: END + 2 * 3_600_000 });
  t.w.db.run("UPDATE work_item SET linear_issue_id = ?, state = ? WHERE id = 'work-x'", [
    issueId,
    state,
  ]);
  if (state === "merged") {
    t.w.db.run("INSERT INTO item_pull_request VALUES ('work-x', 42, 'https://gh/pull/42', ?)", [
      END,
    ]);
    t.w.db.run(
      "INSERT INTO remote_merge_fact VALUES ('work-x', 'acme', 'a', 42, 'https://gh/pull/42', ?, ?)",
      [MERGE, END + 3_000],
    );
  }
  await t.sync();
  return id;
}

/** Reopens the report: leaving for the history and coming back reads it again. */
async function reopen(t: ReturnType<typeof harness>, path: string) {
  await t.open("/improvements/history");
  await t.open(path);
}

const now = (t: ReturnType<typeof harness>) => t.find('[data-retro-item="p1"] [data-retro-now]');

describe("retro history", () => {
  test("lists each period with sessions, profile, decisions and issue links, without excerpts", async () => {
    const t = harness();
    t.as("admin");
    await t.open("/improvements/history");
    const row = t.find('[data-retro-row="r1"]');
    expect(row.textContent).toContain("2026-10-22 to 2026-10-29");
    expect(row.textContent).toContain("Settings revision 1 · codex · agent default model");
    expect(row.textContent).toContain("2 to review");
    expect(row.querySelector("td.hide-phone")!.textContent).toBe("2");
    expect(t.text()).toContain("sets no retention period");
    expect(t.text()).not.toContain("forever");

    const listed = await (await t.w.retroApi("admin", "/api/retros/history", ALL)).response.text();
    expect(listed).not.toContain("Answered question");
    expect(JSON.parse(listed).retros[0]).toMatchObject({
      settingsRevision: 1,
      profile: { agent: "codex", model: null, effort: null },
      digest: { sessions: 2, counted: 4, context: 0 },
      patterns: 2,
      evidence: "complete",
      artifacts: { digest: "stored", prompt: "stored", report: "stored" },
    });

    t.as("ada");
    await t.open("/improvements/settings");
    await t.open("/improvements/history");
    expect(t.find('[data-retro-row="r1"]').textContent).toContain("Partial view");
    const partial = (await (
      await t.w.retroApi("ada", "/api/retros/history")
    ).response.json()) as Json;
    expect(partial.retros[0]).toMatchObject({ digest: null, patterns: null, artifacts: null });
    expect(partial.retros[0].items.links.map((l: { itemId: string }) => l.itemId)).toEqual(["p1"]);

    await filedWork(t, "running");
    await t.poll();
    await t.open("/improvements/settings");
    await t.open("/improvements/history");
    expect(t.find('[data-retro-row="r1"]').textContent).toContain("IMP-1");
    expect(t.find('[data-retro-row="r1"]').textContent).toContain("1 reviewed");
  });

  test("several reports page by period, and a retro added between pages repeats or skips none", async () => {
    const t = harness();
    for (const [id, weeks] of [
      ["r0", -1],
      ["r2", 1],
    ] as const)
      createRetro(t.w.db, {
        id,
        workspaceId: "ws",
        windowStart: START + weeks * 7 * DAY,
        windowEnd: END + weeks * 7 * DAY,
        origin: "scheduled",
        settingsRevision: 1,
        now: END,
      });
    const page = async (cursor: string | null): Promise<Json> =>
      (
        await t.w.retroApi(
          "admin",
          `/api/retros/history?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
          ALL,
        )
      ).response.json();
    const first = await page(null);
    expect(first.retros.map((r: { id: string }) => r.id)).toEqual(["r2"]);
    createRetro(t.w.db, {
      id: "r3",
      workspaceId: "ws",
      windowStart: START + 14 * DAY,
      windowEnd: END + 14 * DAY,
      origin: "manual",
      settingsRevision: 1,
      now: END,
    });
    const second = await page(first.nextCursor);
    const third = await page(second.nextCursor);
    expect([second.retros[0].id, third.retros[0].id, third.nextCursor]).toEqual(["r1", "r0", null]);
    expect((await t.w.retroApi("admin", "/api/retros/history?cursor=7", ALL)).status).toBe(400);

    t.as("admin");
    await t.open("/improvements/history");
    expect(
      [...t.root.querySelectorAll("[data-retro-row]")].map((row) =>
        row.getAttribute("data-retro-row"),
      ),
    ).toEqual(["r3", "r2", "r1", "r0"]);
    expect(t.find('[data-retro-row="r3"]').textContent).toContain("Queued");
    expect(t.find('[data-retro-row="r1"]').textContent).toContain("2 to review");

    await t.open("/improvements/reports/r1");
    await t.poll();
    expect(t.find("#retro-report-heading").textContent).toBe("2026-10-22 to 2026-10-29");
    expect(t.page.view().report.retro.id).toBe("r1");
  });

  test("a direct link selects the item and loads its saved evidence; Back and Forward keep the report", async () => {
    const t = harness();
    await t.open("/improvements/reports/r1?item=p1");
    const card = t.find('[data-retro-item="p1"]');
    expect(card.getAttribute("aria-current")).toBe("true");
    expect(card.textContent).toContain("Answered question in acme/a for item-a");
    const report = await (await t.w.retroApi("ada", "/api/retros/reports/r1")).response.text();
    expect(report).not.toContain("Answered question");
    const loads = t.requests.filter((r) => r.path === "/api/retros/reports/r1").length;

    await t.open("/improvements/reports/r1");
    expect(t.find('[data-retro-item="p1"]').hasAttribute("aria-current")).toBe(false);
    expect(t.text()).not.toContain("Answered question");
    await t.open("/improvements/reports/r1?item=p1");
    expect(t.find('[data-retro-item="p1"]').textContent).toContain("Answered question in acme/a");
    expect(t.page.view().report.retro.id).toBe("r1");
    expect(t.requests.filter((r) => r.path === "/api/retros/reports/r1").length).toBe(loads + 2);

    await t.open("/improvements/reports/r1?item=p2");
    expect(t.text()).toContain("Item not available");
    expect(t.text()).not.toContain("acme/b for item-b");
    await t.open("/improvements/reports/gone?item=p1");
    expect(t.text()).toContain("Retro not available");
    expect(t.text()).toContain("Return to the history");
  });

  test("downloads the original digest, and refuses after access is lost without showing it", async () => {
    const t = harness();
    t.as("admin");
    await t.open("/improvements/reports/r1");
    expect(t.text()).toContain("not rebuilt from current sessions");
    expect(t.text()).toContain("Coverage: 2 sessions, 4 counted records");
    await t.click('[data-improvement-action="download"][data-file="digest"]');
    await settle();
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0]!.name).toBe("retro-r1-digest.json");
    expect(JSON.parse(t.saved[0]!.text).records).toHaveLength(4);

    rmSync(join(t.w.root, retroArtifact(t.w.db, "r1", "prompt")!.fileName));
    await reopen(t, "/improvements/reports/r1");
    expect(t.find('[data-retro-artifact="prompt"]').textContent).toContain(
      "the stored file is unavailable",
    );

    t.w.db.run("DELETE FROM workspace_repository WHERE repository = 'acme/b'");
    await t.click('[data-improvement-action="download"][data-file="report"]');
    await settle();
    expect(t.saved).toHaveLength(1);
    expect(t.find("[data-retro-download-error]").textContent).toContain(
      "Paws refused the download",
    );
    expect(t.find('[data-retro-downloads="denied"]')).toBeTruthy();
    expect(t.text()).not.toContain("acme/b for item-b");

    t.as("ada");
    await reopen(t, "/improvements/reports/r1");
    expect(t.find('[data-retro-downloads="denied"]').textContent).toContain(
      "every repository and session",
    );
    expect(t.root.querySelector('[data-improvement-action="download"]')).toBeNull();
  });

  test("an old report shows the current outcome apart from its frozen claims", async () => {
    const t = harness();
    const id = await filedWork(t, "merged");
    await t.open("/improvements/reports/r1");
    expect(now(t).getAttribute("data-retro-now")).toBe("awaiting_verification");
    expect(now(t).textContent).toContain("IMP-1");
    expect(now(t).textContent).toContain("Verification: Due");
    const card = t.find('[data-retro-item="p1"]').textContent;
    expect(card).toContain("Make branch-tip recovery durable.");
    expect(card).toContain("Decision: accepted");

    const version = (await t.w.api("ada", `/api/improvements/${id}/follow-through`)).body
      .followThrough.version;
    const verified = await t.w.api("ada", `/api/improvements/${id}/verification`, {
      expectedVersion: version,
      outcome: "verified",
      check: "Weekly retro push-recovery questions",
      result: "None in the two retros after the merge.",
      revision: MERGE,
      evidence: { kind: "attestation" },
    });
    expect(verified.status).toBe(200);
    await reopen(t, "/improvements/reports/r1");
    expect(now(t).getAttribute("data-retro-now")).toBe("verified");
    expect(t.find('[data-retro-item="p1"]').textContent).toContain(
      "No push-recovery question in the next two retros.",
    );

    const body = (await (
      await t.w.retroApi("ada", "/api/retros/reports/r1")
    ).response.json()) as Json;
    t.answers.set("/api/retros/reports/r1", () =>
      Response.json({ ...body, current: { p1: null } }),
    );
    await reopen(t, "/improvements/reports/r1");
    expect(now(t).getAttribute("data-retro-now")).toBe("inaccessible");
    expect(t.find('[data-retro-item="p1"]').textContent).toContain(
      "Make branch-tip recovery durable.",
    );
  });

  test("canceled work shows as canceled now, not as a resolved report item", async () => {
    const t = harness();
    await filedWork(t, "cancelled");
    await t.open("/improvements/reports/r1");
    expect(now(t).getAttribute("data-retro-now")).toBe("canceled");
    expect(now(t).textContent).toContain("Implementation: Canceled");
  });
});
