import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDb, tempHome } from "./helpers";
import { FakeClock } from "../src/core";
import {
  sqliteDb,
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
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { answerQuestion } from "./questions";

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
  const tracker = createFakeTracker();
  const journal: string[] = [];
  const orchestrator = new Orchestrator({
    tracker,
    journal: (line) => journal.push(line),
    db,
    pawsRoot: root,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    remoteExecution: { agentForItem: () => runner, agentForSession: () => runner },
  });
  let n = 0;
  const seed = async (state: string, snapshot = true) => {
    const queued = insertQueuedItem(db, { id: `item-${++n}`, now: 1000 });
    const { item, run } = await beginImplementRun(sqliteDb(db), queued.id, 1000);
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
  return { db, root, orchestrator, seed, save, calls, tracker, journal };
}

test("saving without the toggle leaves all snapshots byte-for-byte unchanged", async () => {
  const f = fixture();
  const waiting = await f.seed("awaiting_input");
  const before = readFileSync(waiting.file, "utf8");
  for (const apply of [undefined, false]) {
    expect((await f.save(apply))!.status).toBe(200);
    expect(readFileSync(waiting.file, "utf8")).toBe(before);
  }
});

test("only unfinished runs without live work leases change; queued items still resolve at start", async () => {
  const f = fixture();
  const waiting = [];
  for (const s of ["awaiting_input", "running", "verifying", "paused", "recovering"])
    waiting.push(await f.seed(s));
  const expired = await f.seed("running"),
    ended = await f.seed("running"),
    executing = await f.seed("running");
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
  const untouched = [executing];
  for (const s of ["completed", "merged", "cancelled", "queued"]) untouched.push(await f.seed(s));
  const original = untouched.map((entry) => readFileSync(entry.file, "utf8"));
  const queued = insertQueuedItem(f.db, { id: "not-started" });
  const noSnapshot = await f.seed("recovering", false);
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
    ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
    profileSnapshot(id: string): unknown;
  };
  const next = await internals.ensureRun(queued);
  expect(await internals.profileSnapshot(next.id)).toEqual(profiles);
});

test("agent change announces once at session start, including after a new run", async () => {
  const f = fixture();
  const waiting = await f.seed("awaiting_input");
  await f.save(true);
  const internal = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
    remoteAgentForItem(id: string): (input: RunAgentOptions) => Promise<RunAgentResult>;
  };
  f.db.run("UPDATE run SET status='ended' WHERE id=?", [waiting.run.id]);
  f.db.run("UPDATE work_item SET state='running' WHERE id=?", [waiting.item.id]);
  const run = await internal.ensureRun(getWorkItem(f.db, waiting.item.id)!);
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
  const lines = (await listOutbox(sqliteDb(f.db))).filter((row) =>
    (row.payload as { body?: string }).body?.startsWith("Switched to"),
  );
  expect(lines.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Switched to codex new as set in Settings.",
  ]);
});

test("a retry resolves profiles from Settings, not the previous run's snapshot", async () => {
  const f = fixture();
  const failed = await f.seed("running");
  writeAgentSettings(join(f.root, "config.toml"), { defaults: profiles, projects: [] });
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [failed.run.id]);
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
    readProfileSnapshot(id: string): unknown;
  };
  const next = await internals.ensureRun(getWorkItem(f.db, failed.item.id)!);
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
  const waiting = await f.seed("awaiting_input");
  await f.save(true);
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
    readProfileSnapshot(id: string): { profiles?: unknown; settingsSwitch?: unknown } | null;
  };
  const pending = internals.readProfileSnapshot(waiting.run.id)!.settingsSwitch;
  expect(pending).toMatchObject({ previousAgent: "claude" });
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [waiting.run.id]);
  f.db.run("UPDATE work_item SET state='running' WHERE id=?", [waiting.item.id]);
  const next = await internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  expect(internals.readProfileSnapshot(next.id)).toEqual({ profiles, settingsSwitch: pending });
  // Settings moved back to the original agent: there is no switch left to announce.
  writeAgentSettings(join(f.root, "config.toml"), { defaults: oldProfiles, projects: [] });
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [next.id]);
  const back = await internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  expect(internals.readProfileSnapshot(back.id)).toEqual({ profiles: oldProfiles });
});

test("model-only changes preserve candidate and do not announce an agent switch", async () => {
  const f = fixture();
  const waiting = await f.seed("paused");
  writeAgentSettings(join(f.root, "config.toml"), {
    defaults: { ...oldProfiles, implementer: { agent: "claude", model: "new" } },
    projects: [],
  });
  expect(await f.orchestrator.applyAgentSettingsToWaiting()).toBe(1);
  expect(JSON.parse(readFileSync(waiting.file, "utf8"))).toEqual({
    profiles: { ...oldProfiles, implementer: { agent: "claude", model: "new" } },
    candidate: waiting.candidate,
  });
});

test("an existing remote invocation resolves updated waiting profiles and role-specific fallback", async () => {
  const f = fixture();
  const waiting = await f.seed("running");
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
  expect((await f.calls[0]!.resolveProfiles!()).profile).toEqual(oldProfiles.implementer);
  const reviewerFallback = { agent: "codex", model: "fallback-review" } as const;
  writeAgentSettings(join(f.root, "config.toml"), {
    defaults: { ...profiles, reviewerFallback },
    projects: [],
  });
  expect(await f.orchestrator.applyAgentSettingsToWaiting()).toBe(1);
  expect(await f.calls[0]!.resolveProfiles!()).toEqual({
    profile: profiles.implementer,
    fallbackProfile: undefined,
  });
  expect(await f.calls[1]!.resolveProfiles!()).toEqual({
    profile: profiles.reviewer,
    fallbackProfile: reviewerFallback,
  });
});

test.each([false, true])(
  "config edits reconcile a waiting run before it starts, prior observation=%s",
  async (observed) => {
    const f = fixture();
    writeAgentSettings(join(f.root, "config.toml"), { defaults: oldProfiles, projects: [] });
    const waiting = await f.seed("paused");
    const internals = f.orchestrator as unknown as {
      ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
      remoteAgentForItem(id: string): (input: RunAgentOptions) => Promise<RunAgentResult>;
    };
    if (observed) await internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
    writeAgentSettings(join(f.root, "config.toml"), { defaults: profiles, projects: [] });
    f.db.run("UPDATE work_item SET state='running' WHERE id=?", [waiting.item.id]);
    expect((await internals.ensureRun(getWorkItem(f.db, waiting.item.id)!)).id).toBe(
      waiting.run.id,
    );
    await internals.remoteAgentForItem(waiting.item.id)({
      role: "implementer",
      runId: waiting.run.id,
      itemId: waiting.item.id,
      pawsRoot: f.root,
      worktreePath: f.root,
      prompt: "Continue",
      profile: oldProfiles.implementer,
    });
    expect(f.calls.map((call) => call.profile)).toEqual([profiles.implementer]);
    expect(JSON.parse(readFileSync(waiting.file, "utf8"))).toMatchObject({
      profiles,
      candidate: waiting.candidate,
    });
  },
);

test("automatic reconciliation waits for a live runner lease to end", async () => {
  const f = fixture();
  const waiting = await f.seed("running");
  writeAgentSettings(join(f.root, "config.toml"), { defaults: profiles, projects: [] });
  f.db.run("PRAGMA foreign_keys=OFF");
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
    [waiting.run.id, "runner", "workspace", 1, 0, "command", 2000],
  );
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
  };
  await internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  expect(JSON.parse(readFileSync(waiting.file, "utf8")).profiles).toEqual(oldProfiles);
  f.db.run("UPDATE runner_work SET ended_at=1000 WHERE run_id=?", [waiting.run.id]);
  await internals.ensureRun(getWorkItem(f.db, waiting.item.id)!);
  expect(JSON.parse(readFileSync(waiting.file, "utf8")).profiles).toEqual(profiles);
});

test("a retired account order in config.toml changes no waiting run and reaches no runner", async () => {
  const f = fixture();
  const config = join(f.root, "config.toml");
  writeAgentSettings(config, { defaults: oldProfiles, projects: [] });
  const waiting = await f.seed("paused");
  const before = readFileSync(waiting.file, "utf8");
  writeFileSync(
    config,
    `${readFileSync(config, "utf8")}\n[agents.defaults.accounts]\nimplementer = ["01J0000000000000000000000A"]\nreviewer = ["01J0000000000000000000000X"]\n`,
  );
  expect(await f.orchestrator.applyAgentSettingsToWaiting()).toBe(0);
  expect(readFileSync(waiting.file, "utf8")).toBe(before);
  const internal = f.orchestrator as unknown as {
    remoteAgentForItem(id: string): (input: RunAgentOptions) => Promise<RunAgentResult>;
  };
  await internal.remoteAgentForItem(waiting.item.id)({
    role: "reviewer",
    runId: waiting.run.id,
    itemId: waiting.item.id,
    pawsRoot: f.root,
    worktreePath: f.root,
    prompt: "Review",
  });
  expect(f.calls[0]).not.toHaveProperty("accounts");
});

test("Acme labels change only the next run and a failed Linear read retains its labels", async () => {
  const f = fixture();
  writeAgentSettings(join(f.root, "config.toml"), {
    defaults: oldProfiles,
    projects: [],
    presets: {
      Opus: { agent: "claude", model: "opus" },
      Codex: { agent: "codex", model: "acme-codex" },
    },
  });
  const failed = await f.seed("running");
  const item = () => getWorkItem(f.db, failed.item.id)!;
  const internals = f.orchestrator as unknown as {
    ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
  };
  const labels = (implementer: string) =>
    f.tracker.repositoryHints.set(item().linearIssueId, {
      mentions: [],
      issueLabels: [],
      parentLabels: [],
      projectLabels: [],
      profileLabels: { implementer },
    });
  const snapshot = (id: string) =>
    JSON.parse(readFileSync(join(runDir(f.root, id), "agent-profile.json"), "utf8"));
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [failed.run.id]);
  labels("Opus");
  const opus = await internals.ensureRun(item());
  expect(snapshot(opus.id).profiles.implementer.model).toBe("opus");
  labels("Codex");
  expect((await internals.ensureRun(item())).id).toBe(opus.id);
  expect(snapshot(opus.id).profiles.implementer.model).toBe("opus");
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [opus.id]);
  const codex = await internals.ensureRun(item());
  expect(snapshot(codex.id).profiles.implementer.model).toBe("acme-codex");
  f.tracker.issueRepositoryHints = async () => {
    throw new Error("Linear offline");
  };
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [codex.id]);
  const fallback = await internals.ensureRun(item());
  expect(snapshot(fallback.id).profileLabels).toEqual({ implementer: "Codex" });
  expect(snapshot(fallback.id).profiles.implementer.model).toBe("acme-codex");
  expect(f.journal.filter((line) => line.includes("readProfileLabels"))).toHaveLength(1);
});

const presets = {
  Opus: { agent: "claude", model: "opus" },
  Codex: { agent: "codex", model: "acme-codex" },
} as const;

type Gate = {
  ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
  checkProfileLabels(item: WorkItemRecord, runId: string): Promise<boolean>;
  remoteAgentForItem(id: string): (input: RunAgentOptions) => Promise<RunAgentResult>;
};

/** A retrying Acme item whose failed run saved old profiles, with labels set in the Linear fake. */
async function labelled() {
  const f = fixture();
  writeAgentSettings(join(f.root, "config.toml"), {
    defaults: oldProfiles,
    projects: [],
    presets,
  });
  const failed = await f.seed("running");
  f.db.run("UPDATE work_item SET session_key='acme-session' WHERE id=?", [failed.item.id]);
  f.db.run("UPDATE run SET status='lost' WHERE id=?", [failed.run.id]);
  const item = () => getWorkItem(f.db, failed.item.id)!;
  const gate = f.orchestrator as unknown as Gate;
  const label = (profileLabels: { implementer?: string; reviewer?: string }) =>
    f.tracker.repositoryHints.set(item().linearIssueId, {
      mentions: [],
      issueLabels: [],
      parentLabels: [],
      projectLabels: [],
      profileLabels,
    });
  const snapshot = (id: string) =>
    JSON.parse(readFileSync(join(runDir(f.root, id), "agent-profile.json"), "utf8"));
  const bodies = async () =>
    (await listOutbox(sqliteDb(f.db))).map((row) => (row.payload as { body?: string }).body ?? "");
  const lose = (id: string) => f.db.run("UPDATE run SET status='lost' WHERE id=?", [id]);
  return { ...f, item, gate, label, snapshot, bodies, lose };
}

test("an Implementer label starts the run with its preset and names the source once", async () => {
  const f = await labelled();
  f.label({ implementer: "Opus" });
  const run = await f.gate.ensureRun(f.item());
  expect(f.snapshot(run.id).profiles.implementer).toEqual(presets.Opus);
  expect(f.snapshot(run.id).profiles.labelProblems).toBeUndefined();
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(true);
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(true);
  expect((await f.bodies()).filter((body) => body === "Implementer: Opus (label)")).toHaveLength(1);
  await f.gate.remoteAgentForItem(f.item().id)({
    role: "implementer",
    runId: run.id,
    itemId: f.item().id,
    pawsRoot: f.root,
    worktreePath: f.root,
    prompt: "Implement acme",
    profile: presets.Opus,
  });
  expect(f.calls.map((call) => call.profile)).toEqual([presets.Opus]);
});

test("a label that changes the agent is announced by the next run", async () => {
  const f = await labelled();
  f.label({ implementer: "Opus" });
  const opus = await f.gate.ensureRun(f.item());
  f.label({ implementer: "Codex" });
  f.lose(opus.id);
  const codex = await f.gate.ensureRun(f.item());
  expect(f.snapshot(codex.id).settingsSwitch).toMatchObject({ previousAgent: "claude" });
  await f.gate.remoteAgentForItem(f.item().id)({
    role: "implementer",
    runId: codex.id,
    itemId: f.item().id,
    pawsRoot: f.root,
    worktreePath: f.root,
    prompt: "Implement acme",
    profile: presets.Codex,
  });
  expect(await f.bodies()).toContain(
    "Switched to codex acme-codex from the Implementer label Codex.",
  );
});

test("an unknown label asks, starts nothing, and Use the default holds for the item", async () => {
  const f = await labelled();
  f.label({ implementer: "Acme unknown" });
  const run = await f.gate.ensureRun(f.item());
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(false);
  const open = findOpenQuestion(f.db, "acme-session")!;
  expect(open.body).toContain('Implementer label "Acme unknown": no preset has this name');
  expect(open.body).toContain("Available presets: Opus, Codex.");
  expect(open.options).toEqual(["Use the default", "I fixed the label"]);
  expect(f.item().state).toBe("awaiting_input");
  expect(f.db.query("SELECT status FROM run WHERE id=?").get(run.id)).toEqual({ status: "ended" });
  await answerQuestion(f.db, open.id, { answer: "Use the default", answeredBy: "acme-user" });
  f.db.run("UPDATE work_item SET state='running' WHERE id=?", [f.item().id]);
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(true);
  expect(f.snapshot(run.id).profiles.implementer).toEqual(oldProfiles.implementer);
  f.lose(run.id);
  const next = await f.gate.ensureRun(f.item());
  expect(await f.gate.checkProfileLabels(f.item(), next.id)).toBe(true);
  expect(f.snapshot(next.id).profiles.implementer).toEqual(oldProfiles.implementer);
});

test("I fixed the label reads the corrected label before the run goes on", async () => {
  const f = await labelled();
  f.label({ implementer: "Acme unknown" });
  const run = await f.gate.ensureRun(f.item());
  await f.gate.checkProfileLabels(f.item(), run.id);
  await answerQuestion(f.db, findOpenQuestion(f.db, "acme-session")!.id, {
    answer: "I fixed the label",
    answeredBy: "acme-user",
  });
  f.label({ implementer: "Opus" });
  f.db.run("UPDATE work_item SET state='running' WHERE id=?", [f.item().id]);
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(true);
  expect(f.snapshot(run.id).profiles.implementer).toEqual(presets.Opus);
  expect(await f.bodies()).toContain("Implementer: Opus (label)");
});

test("a reviewer label equal to the implementer asks the same question", async () => {
  const f = await labelled();
  f.label({ implementer: "Opus", reviewer: "Opus" });
  const run = await f.gate.ensureRun(f.item());
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(false);
  const open = findOpenQuestion(f.db, "acme-session")!;
  expect(open.body).toContain('Reviewer label "Opus"');
  expect(open.options).toEqual(["Use the default", "I fixed the label"]);
});

test("without a Linear session an unusable label fails the item instead of hanging", async () => {
  const f = await labelled();
  f.label({ implementer: "Acme unknown" });
  const run = await f.gate.ensureRun(f.item());
  f.db.run("UPDATE work_item SET session_key=NULL WHERE id=?", [f.item().id]);
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(false);
  expect(f.item().state).toBe("failed");
});

test("with no previous labels a failed Linear read uses none and journals once", async () => {
  const f = await labelled();
  f.tracker.issueRepositoryHints = async () => {
    throw new Error("Linear offline");
  };
  const run = await f.gate.ensureRun(f.item());
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(true);
  expect(f.snapshot(run.id).profiles.implementer).toEqual(oldProfiles.implementer);
  expect(f.journal.filter((line) => line.includes("readProfileLabels"))).toHaveLength(1);
});

test("without labels a new run saves the Settings profiles and asks nothing", async () => {
  const f = await labelled();
  f.label({});
  const run = await f.gate.ensureRun(f.item());
  expect(await f.gate.checkProfileLabels(f.item(), run.id)).toBe(true);
  expect(f.snapshot(run.id).profiles).toEqual(oldProfiles);
  expect(findOpenQuestion(f.db, "acme-session")).toBeNull();
  expect((await f.bodies()).filter((body) => body.includes("(label)"))).toEqual([]);
});
