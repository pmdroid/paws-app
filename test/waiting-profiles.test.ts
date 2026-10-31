import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDb, tempHome } from "./helpers";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  insertQueuedItem,
  listOutbox,
  getWorkItem,
  type WorkItemRecord,
} from "../src/db";
import { runDir, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { writeAgentSettings } from "../src/config";
import { handleAgentSettingsRequest } from "../src/settings";
import { Orchestrator } from "../src/loop";

const oldProfiles = {
  implementer: { agent: "claude", model: "old" },
  reviewer: { agent: "codex", model: "review" },
} as const;
const profiles = {
  implementer: { agent: "codex", model: "new" },
  reviewer: { agent: "claude", model: "review" },
} as const;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const db = tempDb(),
    root = tempHome(),
    clock = new FakeClock(1000);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const calls: RunAgentOptions[] = [];
  const runner = async (input: RunAgentOptions): Promise<RunAgentResult> => {
    calls.push(input);
    await input.onEvent?.({
      type: "session_started",
      role: input.role,
      sessionId: "fresh",
      cwd: root,
      identity: { session: "fresh", model: input.profile!.model!, provider: "openai" },
    });
    return {
      role: input.role,
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
    };
  };
  const orchestrator = new Orchestrator({
    db,
    pawsRoot: root,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    remoteExecution: { agentForItem: () => runner, agentForSession: () => runner },
  });
  let n = 0;
  const seed = (state: string, snapshot = true) => {
    const queued = insertQueuedItem(db, { id: `item-${++n}`, now: 1000 });
    const { item, run } = beginImplementRun(db, queued.id, 1000);
    db.run("UPDATE work_item SET state=? WHERE id=?", [state, item.id]);
    const file = join(runDir(root, run.id), "agent-profile.json");
    mkdirSync(runDir(root, run.id), { recursive: true });
    const candidate = { session: "prior", model: "old", provider: "anthropic" };
    if (snapshot) writeFileSync(file, JSON.stringify({ profiles: oldProfiles, candidate }));
    return { item, run, file, candidate };
  };
  const save = (applyToWaiting?: boolean) =>
    handleAgentSettingsRequest(
      new Request("http://localhost/api/settings/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-paws-csrf": "test" },
        body: JSON.stringify({
          defaults: profiles,
          projects: [],
          ...(applyToWaiting === undefined ? {} : { applyToWaiting }),
        }),
      }),
      {
        configPath: join(root, "config.toml"),
        csrfToken: "test",
        applyToWaiting: () => orchestrator.applyAgentSettingsToWaiting(),
      },
    );
  return { db, root, orchestrator, seed, save, calls };
}

test("saving without the toggle leaves all snapshots byte-for-byte unchanged", async () => {
  const f = fixture();
  const waiting = f.seed("awaiting_input");
  const before = readFileSync(waiting.file, "utf8");
  for (const apply of [undefined, false]) {
    expect((await f.save(apply))!.status).toBe(200);
    expect(readFileSync(waiting.file, "utf8")).toBe(before);
  }
});

test("only unfinished runs without live work leases change; queued items still resolve at start", async () => {
  const f = fixture();
  const waiting = ["awaiting_input", "running", "verifying", "paused", "recovering"].map((s) =>
    f.seed(s),
  );
  const expired = f.seed("running"),
    ended = f.seed("running"),
    executing = f.seed("running");
  f.db.run("PRAGMA foreign_keys=OFF");
  for (const [entry, lease, end] of [
    [expired, 1000, null],
    [ended, 2000, 999],
    [executing, 2000, null],
  ] as const)
    f.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,?,?,?,?,?,?,?)",
      [entry.run.id, "runner", "workspace", 1, 0, entry.run.id, lease, end],
    );
  const untouched = [
    executing,
    ...["completed", "merged", "cancelled", "queued"].map((s) => f.seed(s)),
  ];
  const original = untouched.map((entry) => readFileSync(entry.file, "utf8"));
  const queued = insertQueuedItem(f.db, { id: "not-started" });
  const noSnapshot = f.seed("recovering", false);
  const response = await f.save(true);
  expect(await response!.json()).toMatchObject({ waitingRuns: 7 });
  for (const entry of [...waiting, expired, ended])
    expect(JSON.parse(readFileSync(entry.file, "utf8"))).toMatchObject({
      profiles,
      candidate: entry.candidate,
    });
  untouched.forEach((entry, index) =>
    expect(readFileSync(entry.file, "utf8")).toBe(original[index]!),
  );
  expect(existsSync(noSnapshot.file)).toBe(false);
  expect(getWorkItem(f.db, queued.id)!.currentRunId).toBeNull();
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): { id: string };
    profileSnapshot(id: string): unknown;
  };
  const next = internals.ensureRun(queued);
  expect(internals.profileSnapshot(next.id)).toEqual(profiles);
});

test("agent change announces once at session start, including after a new run", async () => {
  const f = fixture();
  const waiting = f.seed("awaiting_input");
  await f.save(true);
  const internal = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): { id: string };
    remoteAgentForItem(id: string): (input: RunAgentOptions) => Promise<RunAgentResult>;
  };
  f.db.run("UPDATE run SET status='ended' WHERE id=?", [waiting.run.id]);
  f.db.run("UPDATE work_item SET state='running' WHERE id=?", [waiting.item.id]);
  const run = internal.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  const input: RunAgentOptions = {
    role: "implementer",
    runId: run.id,
    itemId: waiting.item.id,
    pawsRoot: f.root,
    worktreePath: f.root,
    prompt: "Continue",
    profile: oldProfiles.implementer,
  };
  await internal.remoteAgentForItem(waiting.item.id)(input);
  await internal.remoteAgentForItem(waiting.item.id)(input);
  expect(f.calls.map((c) => c.profile)).toEqual([profiles.implementer, profiles.implementer]);
  const lines = listOutbox(f.db).filter((row) =>
    (row.payload as { body?: string }).body?.startsWith("Switched to"),
  );
  expect(lines.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Switched to codex new as set in Settings.",
  ]);
});

test("a retry resolves profiles from Settings, not the previous run's snapshot", () => {
  const f = fixture();
  const failed = f.seed("running");
  writeAgentSettings(join(f.root, "config.toml"), { defaults: profiles, projects: [] });
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [failed.run.id]);
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): { id: string };
    readProfileSnapshot(id: string): unknown;
  };
  const next = internals.ensureRun(getWorkItem(f.db, failed.item.id)!);
  expect(next.id).not.toBe(failed.run.id);
  expect(getWorkItem(f.db, failed.item.id)!.currentRunId).toBe(next.id);
  expect(internals.readProfileSnapshot(next.id)).toEqual({ profiles });
  expect(JSON.parse(readFileSync(failed.file, "utf8"))).toEqual({
    profiles: oldProfiles,
    candidate: failed.candidate,
  });
});

test("a pending agent switch announcement carries to a retry's new run", async () => {
  const f = fixture();
  const waiting = f.seed("awaiting_input");
  await f.save(true);
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): { id: string };
    readProfileSnapshot(id: string): { profiles?: unknown; settingsSwitch?: unknown } | null;
  };
  const pending = internals.readProfileSnapshot(waiting.run.id)!.settingsSwitch;
  expect(pending).toMatchObject({ previousAgent: "claude" });
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [waiting.run.id]);
  f.db.run("UPDATE work_item SET state='running' WHERE id=?", [waiting.item.id]);
  const next = internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  expect(internals.readProfileSnapshot(next.id)).toEqual({ profiles, settingsSwitch: pending });
  // Settings moved back to the original agent: there is no switch left to announce.
  writeAgentSettings(join(f.root, "config.toml"), { defaults: oldProfiles, projects: [] });
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [next.id]);
  const back = internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  expect(internals.readProfileSnapshot(back.id)).toEqual({ profiles: oldProfiles });
});

test("model-only changes preserve candidate and do not announce an agent switch", () => {
  const f = fixture();
  const waiting = f.seed("paused");
  writeAgentSettings(join(f.root, "config.toml"), {
    defaults: { ...oldProfiles, implementer: { agent: "claude", model: "new" } },
    projects: [],
  });
  expect(f.orchestrator.applyAgentSettingsToWaiting()).toBe(1);
  expect(JSON.parse(readFileSync(waiting.file, "utf8"))).toEqual({
    profiles: { ...oldProfiles, implementer: { agent: "claude", model: "new" } },
    candidate: waiting.candidate,
  });
});

test("an existing remote invocation resolves updated waiting profiles and role-specific fallback", async () => {
  const f = fixture();
  const waiting = f.seed("running");
  const internal = f.orchestrator as unknown as {
    remoteAgentForItem(id: string): (input: RunAgentOptions) => Promise<RunAgentResult>;
  };
  for (const role of ["implementer", "reviewer"] as const)
    await internal.remoteAgentForItem(waiting.item.id)({
      role,
      runId: waiting.run.id,
      itemId: waiting.item.id,
      pawsRoot: f.root,
      worktreePath: f.root,
      prompt: "Continue",
    });
  expect(f.calls[0]!.resolveProfiles!().profile).toEqual(oldProfiles.implementer);
  const reviewerFallback = { agent: "codex", model: "fallback-review" } as const;
  writeAgentSettings(join(f.root, "config.toml"), {
    defaults: { ...profiles, reviewerFallback },
    projects: [],
  });
  expect(f.orchestrator.applyAgentSettingsToWaiting()).toBe(1);
  expect(f.calls[0]!.resolveProfiles!()).toEqual({
    profile: profiles.implementer,
    fallbackProfile: undefined,
  });
  expect(f.calls[1]!.resolveProfiles!()).toEqual({
    profile: profiles.reviewer,
    fallbackProfile: reviewerFallback,
  });
});
