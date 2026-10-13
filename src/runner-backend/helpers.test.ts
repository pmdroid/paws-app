import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../db";
import { recoverAcpConversation, type RunAgentOptions } from "../acp";
import { createRunnerHelpers } from "../runner-helpers";
import { workspaceId, workspaceTokenHash, issueWorkspaceBootstrap } from "../workspace";
import { createRemoteSessionAgentRunner } from "./helpers";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-helper-backend-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'Fixture','active',?,?)",
    ["runner", workspace.id, userId, now, now],
  );
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  const helpers = createRunnerHelpers({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const backend = createRemoteSessionAgentRunner({
    db,
    helpers,
    now: () => now,
    pollIntervalMs: 1,
  });
  const input: RunAgentOptions = {
    itemId: "not-an-item",
    runId: "not-a-run",
    worktreePath: root,
    pawsRoot: root,
    role: "implementer",
    profile: { agent: "codex", model: null },
    prompt: "Classify this request",
    readOnly: true,
    checkpoint: false,
  };
  function current() {
    const row = db
      .query<{ id: string }, []>("SELECT id FROM runner_helper ORDER BY rowid DESC")
      .get();
    if (!row) throw new Error("Expected dispatched helper");
    return helpers.current(row.id).command;
  }
  function reply(text = '{"mode":"answer"}') {
    helpers.submit("runner", {
      executionId: "01J00000000000000000000000",
      commandId: current().id,
      role: "implementer",
      stopReason: "end_turn",
      cancelled: false,
      timedOut: false,
      authRequired: false,
      agentExited: true,
      text,
    });
  }
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, backend, input, helpers, current, reply, advance: (ms: number) => (now += ms) };
}

test.each(["classify", "select_repository"] as const)(
  "session backend dispatches %s before item/repository selection and restores its result",
  async (purpose) => {
    const f = fixture();
    let text = "";
    const pending = f.backend.forSession(
      "session",
      purpose,
    )({
      ...f.input,
      onEvent(event) {
        if (
          event.type === "session_update" &&
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text"
        )
          text += event.update.content.text;
      },
    });
    expect(f.current().purpose).toBe(purpose);
    expect(f.current().prompt).toBe(f.input.prompt);
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n).toBe(0);
    f.reply();
    const result = await pending;
    expect(text).toBe('{"mode":"answer"}');
    expect(await recoverAcpConversation(result.transcriptPath!)).toEqual([
      { kind: "response", body: text },
    ]);
    expect(
      f.db.query<{ ended: number }, []>("SELECT ended_at AS ended FROM runner_helper").get()!.ended,
    ).toBeGreaterThan(0);
  },
);

test("session replacement fences a pending helper and releases its canonical assignment", async () => {
  const f = fixture();
  const pending = f.backend.forSession("session", "classify")(f.input);
  advanceLinearSessionGeneration(f.db, "session");
  await expect(pending).rejects.toThrow(/authority changed/);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NULL")
      .get()!.n,
  ).toBe(0);
});

test("cancelling a helper fences later output without invoking a local agent", async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.backend.forSession(
    "session",
    "classify",
  )({ ...f.input, signal: controller.signal });
  const command = f.current();
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(() => f.helpers.current(command.id)).toThrow(/unavailable/);
});

test("a replacement during the event callback cannot return stale classification", async () => {
  const f = fixture();
  let events = 0;
  const pending = f.backend.forSession(
    "session",
    "classify",
  )({
    ...f.input,
    async onEvent() {
      events++;
      advanceLinearSessionGeneration(f.db, "session");
    },
  });
  f.reply();
  await expect(pending).rejects.toThrow(/authority changed/);
  expect(events).toBe(1);
});

test("no active runner fails closed and a deadline cannot retain capacity", async () => {
  const f = fixture();
  f.db.run("UPDATE runner SET status='paused'");
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No available/,
  );
  f.db.run("UPDATE runner SET status='active'");
  const pending = f.backend.forSession("session", "classify")(f.input);
  f.advance(60_000);
  await expect(pending).rejects.toThrow(/timed out/);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NULL")
      .get()!.n,
  ).toBe(0);
});

test("session helpers reject executable-work and file/tool contracts before dispatch", async () => {
  const f = fixture();
  for (const override of [
    { readOnly: false },
    { role: "reviewer" as const },
    { prepareOnly: true },
    { prepareInputFiles: async () => ({ prompt: "x", inputFiles: [] }) },
  ])
    await expect(
      f.backend.forSession("session", "classify")({ ...f.input, ...override }),
    ).rejects.toThrow(/read-only prompt/);
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(0);
});
