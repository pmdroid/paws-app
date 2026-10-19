import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  saveTaskClassification,
  syncWorkspaceMember,
} from "../src/db";
import { createOnboardingPreparation, issueWorkspaceSession } from "../src/workspace";
import { createFakeTracker } from "../src/linear";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const context = { sessionId: "session", generation: 0 };
const signal = () => new AbortController().signal;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-preparation-"));
  const path = join(root, "db.sqlite");
  let db = openDatabase(path);
  migrate(db);
  const now = Date.now();
  db.run("INSERT INTO workspace VALUES('w','org','Workspace',?)", [now]);
  db.run("INSERT INTO workspace VALUES('other','other-org','Other',?)", [now]);
  for (const id of ["member", "outsider"]) {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
    syncWorkspaceMember(db, {
      workspaceId: "w",
      userId: id,
      active: true,
      role: "member",
      teamIds: ["team"],
      now,
    });
  }
  ensureLinearSession(db, { sessionId: "session", creatorId: "member", issueId: "issue" });
  recordLinearInstallation(db, {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  });
  const fingerprint = JSON.stringify({
    installation: {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
    },
    spec: { linearIssueId: "issue" },
  });
  db.run(
    "INSERT INTO workspace_assignment VALUES('session',0,'w','member','fixture-hash',?,'{}',?,'ready')",
    [fingerprint, now + 600000],
  );
  for (const repo of ["one", "two"])
    db.run("INSERT INTO repository_catalog VALUES(?,?,?,?,?,?)", [
      `acme/${repo}`,
      "acme",
      repo,
      `https://github.com/acme/${repo}.git`,
      "main",
      now,
    ]);
  const login = issueWorkspaceSession(db, { workspaceId: "w", userId: "member", now });
  const outsider = issueWorkspaceSession(db, { workspaceId: "w", userId: "outsider", now });
  const binding = { workspaceId: "w", userId: "member", sessionHash: login.session.tokenHash };
  const foreign = { workspaceId: "w", userId: "outsider", sessionHash: outsider.session.tokenHash };
  const tracker = createFakeTracker([]);
  let onRead: (() => Promise<void>) | undefined;
  let suggestions = 0;
  const dependencies = {
    async issueRepositoryHints(issueId: string) {
      await onRead?.();
      return tracker.issueRepositoryHints!(issueId);
    },
    async issueRepositorySuggestions() {
      suggestions++;
      return [];
    },
  };
  let preparation = createOnboardingPreparation({
    db,
    clientId: "client",
    repositories: dependencies,
    now: () => now,
  });
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    get preparation() {
      return preparation;
    },
    tracker,
    binding,
    foreign,
    restart() {
      db.close();
      db = openDatabase(path);
      preparation = createOnboardingPreparation({
        db,
        clientId: "client",
        repositories: dependencies,
        now: () => now,
      });
    },
    onRead(value: () => Promise<void>) {
      onRead = value;
    },
    get suggestions() {
      return suggestions;
    },
  };
}

test("unresolved mode and repository wait for exact answers, persist and create no work or grants", async () => {
  const f = fixture();
  const first = await f.preparation.refresh(context, signal());
  expect(first.state).toBe("waiting_mode");
  expect(first.mode).toBeNull();
  expect(first.offered.map((repo) => repo.repo)).toEqual(["one", "two"]);
  expect(() =>
    f.preparation.answer(context, f.binding, {
      revision: first.revision,
      repository: "use whichever fits",
    }),
  ).toThrow("exact offered");
  const selected = f.preparation.answer(context, f.binding, {
    revision: first.revision,
    mode: "answer_repository",
    repository: "2",
  });
  expect(selected).toMatchObject({
    state: "prepared",
    mode: "answer",
    permission: "read",
    repository: { owner: "acme", repo: "two" },
  });
  f.restart();
  expect(f.preparation.read(context)).toEqual(selected);
  expect(f.db.query("SELECT * FROM work_item").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM runner_work").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM job").all()).toEqual([]);
});

for (const mode of [
  "code",
  "answer",
  "answer_repository",
  "artifact",
  "artifact_repository",
] as const)
  test(`exact mode ${mode} preserves requested access`, async () => {
    const f = fixture();
    const first = await f.preparation.refresh(context, signal());
    const selected = f.preparation.answer(context, f.binding, {
      revision: first.revision,
      mode,
      repository: "acme/one",
    });
    expect(selected.permission).toBe(
      mode === "code" ? "push" : mode.endsWith("_repository") ? "read" : null,
    );
    expect(selected.state).toBe("prepared");
    if (selected.permission === null) expect(selected.repository).toBeNull();
  });

test("saved classification reused without invoking an agent; clarify is never forced to code", async () => {
  const f = fixture();
  saveTaskClassification(f.db, "session:session", { mode: "clarify", question: "Which outcome?" });
  expect((await f.preparation.refresh(context, signal())).mode).toBeNull();
  f.db.run("UPDATE task_request SET classification=?", [
    JSON.stringify({ mode: "artifact", repository: true }),
  ]);
  const selected = await f.preparation.refresh(context, signal());
  expect(selected).toMatchObject({
    mode: "artifact",
    permission: "read",
    state: "waiting_repository",
  });
});

test("existing hints choose from current catalog and team permissions", async () => {
  const f = fixture();
  f.tracker.repositoryHints.set("issue", {
    mentions: ["acme/two"],
    issueLabels: [],
    parentLabels: [],
    projectLabels: [],
  });
  const first = await f.preparation.refresh(context, signal());
  expect(first.repository?.repo).toBe("two");
  expect(f.suggestions).toBe(0);
  f.db.run("INSERT INTO workspace_repository VALUES('w','acme/one','team')");
  expect(f.preparation.read(context)).toBeNull();
  const next = await f.preparation.refresh(context, signal());
  expect(next.repository?.repo).toBe("one");
  expect(next.revision).toBeGreaterThan(first.revision);
});

test("stale revisions and other members cannot answer; free text mode or repository refuses", async () => {
  const f = fixture();
  const first = await f.preparation.refresh(context, signal());
  expect(() =>
    f.preparation.answer(context, f.foreign, { revision: first.revision, mode: "code" }),
  ).toThrow();
  expect(() =>
    f.preparation.answer(context, f.binding, {
      revision: first.revision,
      repository: "https://github.com/evil/repo",
    }),
  ).toThrow();
  const next = f.preparation.answer(context, f.binding, { revision: first.revision, mode: "code" });
  expect(next.state).toBe("waiting_repository");
  expect(() =>
    f.preparation.answer(context, f.binding, { revision: first.revision, repository: "1" }),
  ).toThrow();
});

for (const change of [
  "generation",
  "stop",
  "scope",
  "actor",
  "fingerprint",
  "team",
  "catalog",
  "observer",
  "issue",
] as const)
  test(`${change} invalidates persisted preparation and in-flight metadata reads`, async () => {
    const f = fixture();
    await f.preparation.refresh(context, signal());
    const mutate = () => {
      if (change === "generation") f.db.run("UPDATE linear_session SET generation=1");
      if (change === "stop") f.db.run("UPDATE linear_session SET stopped_at=1");
      if (change === "scope") f.db.run("UPDATE workspace_assignment SET workspace_id='other'");
      if (change === "actor") f.db.run("UPDATE workspace_assignment SET actor_id='outsider'");
      if (change === "fingerprint")
        f.db.run("UPDATE workspace_assignment SET fingerprint= fingerprint || ' '");
      if (change === "team") f.db.run("DELETE FROM workspace_user_team WHERE user_id='member'");
      if (change === "catalog") f.db.run("DELETE FROM repository_catalog WHERE repo='two'");
      if (change === "observer")
        f.db.run("UPDATE workspace_member SET role='observer' WHERE user_id='member'");
      if (change === "issue") f.db.run("UPDATE linear_session SET issue_id='foreign'");
    };
    f.onRead(async () => {
      mutate();
    });
    await expect(f.preparation.refresh(context, signal())).rejects.toThrow();
    try {
      expect(f.preparation.read(context)).toBeNull();
    } catch (error) {
      expect(String(error)).toContain("unavailable");
    }
  });

test("later metadata refresh fences an earlier delayed publication", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.onRead(async () => {
    entered();
    await held;
  });
  const earlier = f.preparation.refresh(context, signal());
  await started;
  f.onRead(async () => {});
  const latest = await f.preparation.refresh(context, signal());
  release();
  await expect(earlier).rejects.toThrow("changed");
  expect(f.preparation.read(context)?.revision).toBe(latest.revision);
});

test("empty catalog and unknown free-text mode remain waiting without guessed code", async () => {
  const f = fixture();
  f.db.run("DELETE FROM repository_catalog");
  const first = await f.preparation.refresh(context, signal());
  expect(first).toMatchObject({ state: "waiting_mode", mode: null, repository: null, offered: [] });
  expect(() =>
    f.preparation.answer(context, f.binding, {
      revision: first.revision,
      mode: "please inspect" as "code",
    }),
  ).toThrow("offered task mode");
  const next = f.preparation.answer(context, f.binding, {
    revision: first.revision,
    mode: "answer_repository",
  });
  expect(next).toMatchObject({ state: "waiting_repository", permission: "read" });
});

test("caller cancellation does not publish a completed metadata read", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.onRead(async () => {
    controller.abort(new Error("fixture-cancelled"));
  });
  await expect(f.preparation.refresh(context, controller.signal)).rejects.toThrow(
    "fixture-cancelled",
  );
  expect(f.preparation.read(context)?.repository).toBeNull();
});

test("a member cannot downgrade a canonical code classification to readonly", async () => {
  const f = fixture();
  saveTaskClassification(f.db, "session:session", { mode: "code" });
  const first = await f.preparation.refresh(context, signal());
  expect(first.permission).toBe("push");
  expect(() =>
    f.preparation.answer(context, f.binding, {
      revision: first.revision,
      mode: "answer_repository",
    }),
  ).toThrow("canonical task mode");
});
