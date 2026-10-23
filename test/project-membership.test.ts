import { expect, test } from "bun:test";
import { applyLinearUserChange, workspaceMember } from "../src/db";
import { parseAgentEvent, parseLinearUserChange } from "../src/linear";
import { issueWorkspaceSession } from "../src/workspace";
import { createProjectFixture } from "./local/project-fixture";

const SIX_HOURS = 6 * 60 * 60_000;

async function approvedProject(f: ReturnType<typeof createProjectFixture>) {
  const preview = await f.projects.preview(f.actor, f.selection, AbortSignal.timeout(10_000));
  await f.projects.approve(f.actor, preview.id, preview.generation, AbortSignal.timeout(10_000));
  f.projects.register(f.jobs);
  await f.jobs.tick();
  return preview.id;
}

function userWebhook(
  f: ReturnType<typeof createProjectFixture>,
  action: string,
  data: Record<string, unknown>,
) {
  return parseAgentEvent(
    JSON.stringify({
      action,
      type: "User",
      data,
      organizationId: "org",
      createdAt: new Date(f.clock.now()).toISOString(),
      webhookTimestamp: f.clock.now(),
    }),
    `delivery-${action}-${String(data["id"])}`,
    f.clock.now(),
  )!;
}

function lastError(f: ReturnType<typeof createProjectFixture>, id: string) {
  return f.db
    .query<{ last_error: string | null }, [string]>(
      "SELECT last_error FROM project_approval WHERE id=?",
    )
    .get(id)!.last_error;
}

test("an approved project makes no membership read while the stored rows are fresh", async () => {
  const f = createProjectFixture();
  try {
    await approvedProject(f);
    const reads = f.memberReads;
    for (let pass = 0; pass < 4; pass++) {
      f.clock.advance(30_000);
      await f.jobs.tick();
    }
    expect(f.memberReads).toBe(reads);
    f.clock.advance(SIX_HOURS);
    await f.jobs.tick();
    expect(f.memberReads).toBe(reads + 2);
  } finally {
    await f.close();
  }
});

test("a User webhook that deactivates the lead denies the next pass without a Linear read", async () => {
  const f = createProjectFixture();
  try {
    const id = await approvedProject(f);
    issueWorkspaceSession(f.db, { workspaceId: "workspace", userId: "lead", now: f.clock.now() });
    expect(lastError(f, id)).toBeNull();
    const change = parseLinearUserChange(
      userWebhook(f, "update", { id: "lead", active: false, guest: false, admin: false }),
    )!;
    expect(change).toEqual({ organizationId: "org", userId: "lead", active: false, guest: false });
    expect(applyLinearUserChange(f.db, { ...change, now: f.clock.now() })).toBe(true);
    expect(workspaceMember(f.db, "workspace", "lead")?.active).toBe(false);
    expect(f.db.query("SELECT 1 FROM workspace_session WHERE user_id='lead'").all()).toEqual([]);
    const reads = f.memberReads;
    f.clock.advance(30_000);
    await f.jobs.tick();
    expect(f.memberReads).toBe(reads);
    expect(lastError(f, id)).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("a User webhook that makes a member a guest turns them into an observer", async () => {
  const f = createProjectFixture();
  try {
    const change = parseLinearUserChange(userWebhook(f, "update", { id: "actor", guest: true }))!;
    expect(applyLinearUserChange(f.db, { ...change, now: f.clock.now() })).toBe(true);
    expect(workspaceMember(f.db, "workspace", "actor")).toMatchObject({
      active: true,
      role: "observer",
    });
  } finally {
    await f.close();
  }
});

test("a permissive User webhook makes the next pass read Linear again", async () => {
  const f = createProjectFixture();
  try {
    await approvedProject(f);
    const change = parseLinearUserChange(
      userWebhook(f, "update", { id: "actor", active: true, guest: false }),
    )!;
    expect(applyLinearUserChange(f.db, { ...change, now: f.clock.now() })).toBe(true);
    const reads = f.memberReads;
    f.clock.advance(30_000);
    await f.jobs.tick();
    expect(f.memberReads).toBe(reads + 2);
    expect(workspaceMember(f.db, "workspace", "actor")?.checkedAt).toBe(f.clock.now());
  } finally {
    await f.close();
  }
});

test("a removed user loses membership and unknown or polled users change nothing", async () => {
  const f = createProjectFixture();
  try {
    const removed = parseLinearUserChange(userWebhook(f, "remove", { id: "actor" }))!;
    expect(removed).toEqual({ organizationId: "org", userId: "actor", active: false, guest: null });
    expect(applyLinearUserChange(f.db, { ...removed, now: f.clock.now() })).toBe(true);
    expect(workspaceMember(f.db, "workspace", "actor")?.active).toBe(false);
    const stranger = parseLinearUserChange(userWebhook(f, "update", { id: "stranger" }))!;
    expect(applyLinearUserChange(f.db, { ...stranger, now: f.clock.now() })).toBe(false);
    const polled = { ...userWebhook(f, "update", { id: "lead", active: false }), source: "poll" };
    expect(parseLinearUserChange(polled as Parameters<typeof parseLinearUserChange>[0])).toBeNull();
  } finally {
    await f.close();
  }
});
