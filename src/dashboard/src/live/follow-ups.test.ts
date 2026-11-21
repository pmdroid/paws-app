import { afterEach, describe, expect, test } from "bun:test";
import {
  beginImplementRun,
  insertQueuedItem,
  recordItemFiledIssueSteps,
  type Db,
} from "../../../db";
import { parseIssueDetailResponse, type IssueDetailResponse } from "../contract";
import { openedView } from "../../test/fixtures";
import { render } from "../client/render";
import { parseRoute } from "../client/route";
import { createLiveStatusProvider } from "./provider";
import { tempStore } from "../../../../test/pglite";

const NOW = 1_700_000_000_000;

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function filed(): Promise<Db> {
  const { db, close } = await tempStore();
  open.push(close);
  await insertQueuedItem(db, { id: "ENG-1", title: "Origin work", sessionKey: "s1", now: NOW });
  await insertQueuedItem(db, {
    id: "ENG-2",
    title: "Fix the cache",
    sessionKey: "s2",
    now: NOW + 5,
  });
  await beginImplementRun(db, "ENG-2", NOW + 6);
  const row = { itemId: "ENG-1", runId: "run", url: null, started: false };
  await db.run((q) =>
    recordItemFiledIssueSteps(q, {
      ...row,
      linearIssueId: "lin-9",
      identifier: "ENG-9",
      title: "Document the flag",
      url: "https://linear.app/acme/issue/ENG-9",
      filedAt: NOW + 2,
    }),
  );
  await db.run((q) =>
    recordItemFiledIssueSteps(q, {
      ...row,
      linearIssueId: "lin-item-ENG-2",
      identifier: "ENG-2",
      title: "Fix the cache",
      started: true,
      filedAt: NOW + 1,
    }),
  );
  return db;
}

async function detail(db: Db, id: string, sessionIds?: string[]): Promise<IssueDetailResponse> {
  const provider = createLiveStatusProvider(db, {
    now: () => new Date(NOW + 10),
    env: {},
    ...(sessionIds === undefined ? {} : { sessionIds }),
  });
  const parsed = parseIssueDetailResponse(JSON.parse(JSON.stringify(await provider.issue(id))));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.response;
}

function page(issue: IssueDetailResponse): string {
  return render({
    route: parseRoute(`/issues/${issue.issue.id}`),
    phase: "ready",
    issue,
    error: null,
    engineUrl: null,
    closeout: openedView(),
  }).content.replace(/\s+/g, " ");
}

describe("follow-ups on the issue page", () => {
  test("an item lists the issues it filed, oldest first, with their Paws state or Linear link", async () => {
    const db = await filed();
    const origin = await detail(db, "ENG-1");
    expect(origin.followUps).toEqual([
      {
        identifier: "ENG-2",
        title: "Fix the cache",
        url: null,
        started: true,
        state: "running",
        path: "/dashboard/issues/ENG-2",
      },
      {
        identifier: "ENG-9",
        title: "Document the flag",
        url: "https://linear.app/acme/issue/ENG-9",
        started: false,
      },
    ]);
    expect(origin.filedFrom).toBeUndefined();
    const html = page(origin);
    expect(html).toContain("Follow-ups");
    const lines = html.match(/<li[^>]*data-follow-up>.*?<\/li>/g)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('href="/issues/ENG-2"');
    expect(lines[0]).toContain("Fix the cache");
    expect(lines[0]).toContain(">Running<");
    expect(lines[1]).toContain('href="https://linear.app/acme/issue/ENG-9"');
    expect(lines[1]).toContain("Document the flag");
    expect(lines[1]).toContain("In Linear, not handed to Paws");
  });

  test("a follow-up's page names the work it was filed from", async () => {
    const db = await filed();
    const followUp = await detail(db, "ENG-2");
    expect(followUp.followUps).toEqual([]);
    expect(followUp.filedFrom).toEqual({
      identifier: "ENG-1",
      title: "Origin work",
      path: "/dashboard/issues/ENG-1",
    });
    const html = page(followUp);
    expect(html).toContain(
      'Filed from <a href="/issues/ENG-1"><span class="lin-id">ENG-1</span>: Origin work</a>',
    );
    expect(html).not.toContain("follow-ups-heading");
  });

  test("a member who may not see the other item sees its identifier only", async () => {
    const db = await filed();
    const followUp = await detail(db, "ENG-2", ["s2"]);
    expect(followUp.filedFrom).toEqual({ identifier: "ENG-1" });
    const html = page(followUp);
    expect(html).toContain('Filed from <span class="lin-id">ENG-1</span>');
    expect(html).not.toContain("Origin work");
    const origin = await detail(db, "ENG-1", ["s1"]);
    expect(origin.followUps[0]).toEqual({ identifier: "ENG-2" });
    const line = page(origin).match(/<li[^>]*data-follow-up>.*?<\/li>/)![0];
    expect(line).not.toContain("href");
    expect(line).not.toContain("Fix the cache");
    expect(line).not.toContain("Running");
  });
});
