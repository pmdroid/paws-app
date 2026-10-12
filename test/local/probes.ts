import { probeCloseoutCommandRunner } from "./closeout-command-runner";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createTokenStore,
  githubOAuthPath,
  loginGitHub,
  PAWS_GITHUB_OAUTH_CLIENT_ID,
  type GitHubTokenStore,
} from "../../src/auth";
import { createCommentMode, createFakeCommentBoard } from "../../src/comments";
import { CommandBus, FakeClock, JOB_KIND } from "../../src/core";
import {
  applyWorkItemEvent,
  claimNextJob,
  completeJob,
  beginImplementRun,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recoverOnStartup,
} from "../../src/db";
import { commentTracker, syncComments } from "../../src/index";
import { createFakeTracker } from "../../src/linear";
import { detectCandidates } from "../../src/setup";
import { enqueueVerifiedMerge } from "../../src/loop";
import { probeLinearQuestionRestart } from "./linear-question-restart";
import { probeHostAcp } from "./host-acp";
import { probePublicTls } from "./public-tls";

export async function probeBoundaries(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  await probeHostAcp(root, observe);
  await probeCloseoutCommandRunner(join(root, "closeout-command-runner"), observe);
  await probePublicTls(root, observe);
  const store: GitHubTokenStore = {
    backend: "file",
    warning: null,
    load: async () => null,
    save: async () => {},
    update: async (change) => change(null) !== null,
    markInvalid: async () => {},
    delete: async () => {},
  };
  const logged: string[] = [];
  const log = console.log;
  let clientId = "";
  console.log = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
  try {
    await loginGitHub({
      store,
      oauthClientId: "Iv1.local-verification-fixture",
      sleep: async () => {},
      openBrowser: async () => {},
      fetch: async (url, init) => {
        if (url.endsWith("/device/code")) {
          clientId = new URLSearchParams(String(init?.body)).get("client_id") ?? "";
          return Response.json({
            device_code: "fake-device",
            user_code: "LOCAL-CODE",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          });
        }
        if (url.endsWith("/access_token"))
          return Response.json({
            access_token: "fake-token",
            token_type: "bearer",
            scope: "repo read:org",
          });
        return Response.json(
          { login: "local-user", id: 1 },
          { headers: { "x-oauth-scopes": "repo, read:org" } },
        );
      },
    });
  } finally {
    console.log = log;
  }
  observe(
    "configured OAuth client reaches the device request",
    clientId === "Iv1.local-verification-fixture",
    clientId,
  );
  observe(
    "default OAuth client is configured",
    PAWS_GITHUB_OAUTH_CLIENT_ID !== "Iv1.paws-oauth-placeholder",
    { configuredDefault: PAWS_GITHUB_OAUTH_CLIENT_ID },
  );
  observe(
    "CLI login prints the device code before polling",
    logged.some((line) => line.includes("LOCAL-CODE")),
    logged,
  );
  const candidate = detectCandidates({
    which: (bin) => (bin === "claude-agent-acp" ? "/fake/claude-agent-acp" : null),
  }).find((entry) => entry.id === "claude");
  observe(
    "adapter-only installation is not advertised as loginable",
    candidate?.loginable === false,
    candidate,
  );
  const brokenStore = createTokenStore({
    home: join(root, "token-probe"),
    platform: "linux",
    which: () => "/fake/secret-tool",
    run: async () => ({
      code: 1,
      stdout: "",
      stderr:
        "secret-tool: The name org.freedesktop.secrets was not provided by any .service files",
    }),
  });
  let storeError = "";
  try {
    await brokenStore.save({
      accessToken: "fake-token",
      refreshToken: null,
      expiresAtMs: null,
      scope: "repo",
      login: "local-user",
      id: 1,
      invalid: false,
    });
  } catch (error) {
    storeError = String(error);
  }
  const saved = storeError === "" ? await brokenStore.load() : null;
  const file = githubOAuthPath(join(root, "token-probe"));
  const mode = saved === null ? null : statSync(file).mode & 0o777;
  const dirMode = saved === null ? null : statSync(dirname(file)).mode & 0o777;
  observe(
    "unavailable Secret Service falls back to the isolated token file",
    storeError === "" &&
      brokenStore.backend === "file" &&
      saved?.accessToken === "fake-token" &&
      mode === 0o600 &&
      dirMode === 0o700,
    { backend: brokenStore.backend, storeError, mode, dirMode, reloaded: saved !== null },
  );
  const clock = new FakeClock(1000);
  const binding = { itemId: "item", linearIssueId: "issue", sessionId: "issue" };
  const restart = await probeLinearQuestionRestart(join(root, "linear-question-restart"));
  observe(
    "threaded question reply survives owned process restart and ignores unrelated replies",
    restart.question.status === "answered" &&
      restart.question.answeredBy === "human-owner" &&
      restart.jobs.filter((job) => job.queue === JOB_KIND.resume).length === 1 &&
      restart.duplicates.length === 0 &&
      restart.ignored.length === 0,
    restart,
  );
  const personalBoard = createFakeCommentBoard({ clock, selfUserId: "personal-token-owner" });
  const personal = createCommentMode({
    board: personalBoard,
    clock,
    selfUserId: "personal-token-owner",
  });
  personal.bind(binding);
  await personal.ask({ itemId: "item", title: "Proceed?", body: "Choose yes or no." });
  clock.advance(1000);
  personalBoard.post({
    issueId: "issue",
    parentId: personalBoard.comments[0]!.id,
    userId: "personal-token-owner",
    body: "yes",
  });
  const ownReply = await personal.sync("issue");
  observe(
    "Linear personal-token owner can answer their own question",
    ownReply.resumed.length === 1,
    { ownReply, phase: personal.phase("item") },
  );
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const issue = "issue-1";
    const item = insertQueuedItem(db, {
      id: "durable-item",
      now: clock.now(),
      sessionKey: issue,
    });
    db.run("UPDATE epic SET linear_issue_id = ?, linear_identifier = ? WHERE id = ?", [
      issue,
      "LOCAL-1",
      item.epicId,
    ]);
    beginImplementRun(db, item.id, clock.now());
    const comments = createFakeCommentBoard({ clock, selfUserId: "local-user" });
    const stopMode = createCommentMode({ board: comments, clock, selfUserId: "local-user" });
    db.run("UPDATE work_item SET linear_issue_id = ?, linear_identifier = ? WHERE id = ?", [
      issue,
      "LOCAL-1",
      item.id,
    ]);
    const tracker = commentTracker(db, createFakeTracker(), stopMode);
    await tracker.postProgress({ sessionId: issue, kind: "thought", body: "Working" });
    clock.advance(1000);
    comments.post({ issueId: issue, body: "/paws stop", userId: "teammate" });
    const commands = new CommandBus();
    await syncComments(db, stopMode, {
      bus: commands,
      onLinearEvent: async () => {},
    });
    observe(
      "Linear stop targets the durable work item",
      getWorkItem(db, item.id)?.state === "cancelled",
      {
        durableId: item.id,
        state: getWorkItem(db, item.id)?.state,
        commentPhase: stopMode.phase(item.id),
      },
    );
    const checkpoint = {
      phase: "merge_queue" as const,
      baseSha: "a".repeat(40),
      wipCommit: "b".repeat(40),
    };
    const recovering = insertQueuedItem(db, { id: "recovering-item", now: clock.now() });
    beginImplementRun(db, recovering.id, clock.now());
    enterMergeQueue(db, recovering.id, checkpoint);
    const original = enqueueVerifiedMerge(db, {
      itemId: recovering.id,
      head: checkpoint.wipCommit,
      summary: "Accepted synthetic candidate",
      now: clock.now(),
    });
    recoverOnStartup(db, clock.now());
    if (getWorkItem(db, recovering.id)?.state === "verifying")
      applyWorkItemEvent(db, recovering.id, "closeout_accepted");
    const reverification = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.reverify] });
    if (reverification === null) throw new Error("Recovery did not schedule re-verification");
    const retry = enqueueVerifiedMerge(db, {
      itemId: recovering.id,
      head: checkpoint.wipCommit,
      summary: "Reverified synthetic candidate",
      now: clock.now(),
      reverifyJobId: reverification.id,
    });
    completeJob(db, reverification, clock.now());
    const runnable = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    observe(
      "reverified merge schedules a runnable retry",
      runnable?.id === retry && retry !== original,
      {
        original,
        retry,
        claimedRetry: runnable?.id ?? null,
        jobs: listJobs(db).map(({ id, queue, status }) => ({ id, queue, status })),
      },
    );
  } finally {
    db.close();
  }
}
