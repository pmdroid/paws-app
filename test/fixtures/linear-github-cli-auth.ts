import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRuntime } from "../../src/config";
import { createLinearGitHubAuth } from "../../src/index";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
} from "../../src/db";
import { GitHubAuthQuestions } from "../../src/loop";
import { findOpenQuestion, getQuestion } from "../../src/questions";

const home = process.argv[2]!;
const bin = join(home, "bin");
const state = join(home, "gh.json");
mkdirSync(bin);
writeFileSync(state, JSON.stringify({ id: 7, active: true }));
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
if(args[0]==="api"&&args[1]==="repos/selected/repository"){console.log(JSON.stringify({permissions:{push:true,pull:true}}));process.exit(0);}
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
const item = insertQueuedItem(db, { id: "task", sessionKey: "session" });
beginImplementRun(db, item.id, 1);
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
