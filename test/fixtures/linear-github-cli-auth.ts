import "../quiet-journal";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRuntime } from "../../src/config";
import { createLinearGitHubAuth } from "../../src/index";
import { checkGitHubCliRepositoryAccess, createGitHubTokenProvider } from "../../src/auth";
import { FakeClock } from "../../src/core";
import { createFakeTracker, type AcceptedLinearEvent } from "../../src/linear";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  getWorkItemRepository,
  getWorkItemRepositoryChoice,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  JobLoop,
  OutboxDispatcher,
} from "../../src/db";
import { attachOrchestrator, GitHubAuthQuestions } from "../../src/loop";
import { findOpenQuestion, getQuestion } from "../../src/questions";

const home = process.argv[2]!;
const denied = process.argv[3] === "denied";
const bin = join(home, "bin");
const state = join(home, "gh.json");
mkdirSync(bin);
writeFileSync(state, JSON.stringify({ id: 7, active: true, denied }));
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env bun
import {readFileSync,writeFileSync} from "node:fs";
const path=${JSON.stringify(state)};
const state=JSON.parse(readFileSync(path,"utf8"));
const args=process.argv.slice(2);
if(args[0]==="auth"&&args[1]==="login"){state.active=true;state.id=Number(args[2]??7);writeFileSync(path,JSON.stringify(state));process.exit(0);}
if(!state.active)process.exit(1);
if(args[0]==="auth"&&args[1]==="status")process.exit(0);
if(args[0]==="auth"&&args[1]==="token"){console.log("synthetic-gh-user-"+state.id);process.exit(0);}
if(args[0]==="api"&&args[1]==="repos/selected/repository"){console.log(JSON.stringify({permissions:{push:!state.denied,pull:!state.denied}}));process.exit(0);}
process.exit(2);
`,
  { mode: 0o700 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
const env = { PAWS_HOME: home, GITHUB_AUTH: "gh" };
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push(url);
  if (url === "https://api.github.com/repos/selected/repository")
    return Response.json({ permissions: { push: false } });
  if (url !== "https://api.github.com/user") throw new Error(`Unexpected offline request ${url}`);
  const token = new Headers(init?.headers).get("authorization")!;
  const id = Number(token.split("-").at(-1));
  return Response.json(
    { id, login: `user-${id}` },
    { headers: { "x-oauth-scopes": "repo,read:org" } },
  );
}) as typeof fetch;
const path = join(home, "paws.db");
let db = openDatabase(path);
migrate(db);
const item = insertQueuedItem(db, { id: "task", sessionKey: "session", now: Date.now() + 60_000 });
if (!denied) beginImplementRun(db, item.id, 1);
const host = createLinearGitHubAuth({
  runtime: loadRuntime(env),
  env,
  repositoryForItem: () => ({
    owner: "selected",
    repo: "repository",
    remoteUrl: "https://github.com/selected/repository.git",
  }),
  actorForItem: () => "linear-owner",
});
if (denied) {
  const auth = new GitHubAuthQuestions(db, host, () => 10);
  const verified = await auth.ensure(
    getWorkItem(db, item.id)!,
    "initial",
    new AbortController().signal,
  );
  let tokenDenied = false;
  try {
    await createGitHubTokenProvider({ auth: "gh", repo: "selected/repository" }).token();
  } catch {
    tokenDenied = true;
  }
  const outcomes: Record<string, boolean | string> = {};
  for (const status of [200, 404, 401, 403, 429, 500]) {
    try {
      outcomes[String(status)] = await checkGitHubCliRepositoryAccess(
        {
          repo: "selected/repository",
          fetch: async () => Response.json({ permissions: { push: false } }, { status }),
        },
        new AbortController().signal,
      );
    } catch (error) {
      outcomes[String(status)] = error instanceof Error ? error.message : String(error);
    }
  }
  const clock = new FakeClock(1_000);
  const jobs = new JobLoop(db, clock);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Implement export",
      description: null,
      subIssues: [],
    },
  ]);
  const repositories = ["repository", "other"].map((repo) => ({
    owner: "selected",
    repo,
    remoteUrl: `https://github.com/selected/${repo}.git`,
  }));
  const selectedAuth = createLinearGitHubAuth({
    runtime: loadRuntime(env),
    env,
    repositoryForItem: (candidate) =>
      getWorkItemRepository(db, candidate.id) ?? getWorkItemRepositoryChoice(db, candidate.id),
    actorForItem: () => "linear-owner",
  });
  let launches = 0;
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    clock,
    outbox: new OutboxDispatcher(db, clock),
    tracker,
    pawsRoot: home,
    githubAuth: selectedAuth,
    repositories,
    repositoryAccess: (candidate, signal, access) =>
      checkGitHubCliRepositoryAccess(
        { repo: `${candidate.owner}/${candidate.repo}`, access },
        signal,
      ),
    launch: () => {
      launches++;
      throw new Error("Denied repository cannot launch ACP");
    },
  });
  const event = (body: string | null): AcceptedLinearEvent => ({
    dedupeKey: body ?? "created",
    deliveryId: null,
    source: "webhook",
    action: body === null ? "created" : "prompted",
    sessionId: "chosen",
    issueId: "issue",
    activityId: body,
    body,
    signal: null,
    updatedAtMs: 2_000,
    actorId: "linear-owner",
    activityCreatedAtMs: 2_000,
    payload: JSON.stringify({ answeredBy: "linear-owner" }),
  });
  await orchestrator.onLinearEvent(event(null));
  await jobs.tick();
  const original = findOpenQuestion(db, "chosen")!;
  await orchestrator.onLinearEvent(event("selected/repository"));
  await jobs.tick();
  const replacement = findOpenQuestion(db, "chosen");
  const bound = getWorkItemRepository(db, original.itemId);
  const questionBodies = db.query<{ body: string }, []>("SELECT body FROM question").all();
  await orchestrator.shutdown();
  beginImplementRun(db, item.id, 1);
  applyWorkItemEvent(db, item.id, "turn_ended");
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  writeFileSync(state, JSON.stringify({ id: 8, active: true, denied: true }));
  const switched = await auth.ensure(
    getWorkItem(db, item.id)!,
    "publication",
    new AbortController().signal,
  );
  writeFileSync(state, JSON.stringify({ id: 7, active: false, denied: true }));
  const fresh = insertQueuedItem(db, { id: "fresh", sessionKey: "fresh" });
  beginImplementRun(db, fresh.id, 1);
  let missing = "";
  try {
    await auth.ensure(getWorkItem(db, fresh.id)!, "initial", new AbortController().signal);
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
  }
  console.log(
    JSON.stringify({
      verified,
      tokenDenied,
      outcomes,
      bound,
      original: original.id,
      replacement: replacement?.id,
      choices: replacement?.options,
      launches,
      statuses: tracker.statuses,
      questionBodies,
      switched,
      missing,
      missingQuestion: findOpenQuestion(db, "fresh"),
      requests,
    }),
  );
  auth.close();
  db.close();
  process.exit(0);
}
let auth = new GitHubAuthQuestions(db, host, () => 10);
const initial = await auth.ensure(
  getWorkItem(db, item.id)!,
  "initial",
  new AbortController().signal,
);
auth.close();
db.close();
db = openDatabase(path);
migrate(db);
auth = new GitHubAuthQuestions(db, host, () => 20);
applyWorkItemEvent(db, item.id, "turn_ended");
applyWorkItemEvent(db, item.id, "closeout_accepted");
writeFileSync(state, JSON.stringify({ id: 7, active: false }));
const blocked = await auth.ensure(
  getWorkItem(db, item.id)!,
  "publication",
  new AbortController().signal,
);
const question = findOpenQuestion(db, "session")!;
const guidance = listOutbox(db).at(-1)?.payload;
const wrongOwner = await auth.retry(question.id, "another-owner");
const login = Bun.spawn([join(bin, "gh"), "auth", "login", "7"], {
  stdout: "pipe",
  stderr: "pipe",
});
if ((await login.exited) !== 0) throw new Error("Offline host login failed");
const retried = await auth.retry(question.id, "linear-owner");
const answered = getQuestion(db, question.id)?.status;
const resumed = listJobs(db).length;
applyWorkItemEvent(db, item.id, "closeout_accepted");
writeFileSync(state, JSON.stringify({ id: 8, active: true }));
const switched = await auth.ensure(
  getWorkItem(db, item.id)!,
  "publication",
  new AbortController().signal,
);
console.log(
  JSON.stringify({
    initial,
    blocked,
    guidance,
    wrongOwner,
    retried,
    answered,
    resumed,
    switched,
    account: db.query("SELECT account_id FROM linear_github_task_account").get(),
    requests,
    storedOAuth: Bun.file(join(home, "secrets", "github-oauth.json")).size > 0,
    gh: JSON.parse(readFileSync(state, "utf8")),
  }),
);
auth.close();
db.close();
