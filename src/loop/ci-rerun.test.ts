import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  insertQueuedItem,
  listCiReruns,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import { CI_ALREADY_RERUN, CI_RERUN_PERMISSION_MISSING, type GitHubClient } from "../github";
import { rerunItemCi } from "./ci-rerun";

const head = "c".repeat(40);
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function fakeGitHub(rerunStatus = 201) {
  const posts: string[] = [];
  const client: GitHubClient = {
    async request(request) {
      if (request.path === "/repos/owner/repo/pulls/7")
        return { status: 200, body: { state: "open", head: { sha: head } } };
      if (request.path.startsWith(`/repos/owner/repo/commits/${head}/check-runs`))
        return {
          status: 200,
          body: {
            check_runs: [
              {
                id: 1,
                name: "test",
                status: "completed",
                conclusion: "cancelled",
                html_url: "https://github.com/owner/repo/actions/runs/41545628595/job/1",
                app: { slug: "github-actions" },
              },
            ],
          },
        };
      if (request.method === "POST") {
        posts.push(request.path);
        return { status: rerunStatus, body: {} };
      }
      throw new Error(`unexpected request ${request.path}`);
    },
  };
  return { client, posts };
}

function rerun(
  db: Database,
  client: GitHubClient,
  journal: string[],
  reason: string,
  requestedBy?: string,
) {
  return rerunItemCi({
    db,
    itemId: "item",
    label: "PAS-1",
    reason,
    github: {
      client,
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      tokenProvider: { mode: "token", tokenFor: async () => "token" },
    },
    now: () => 1_000,
    journal: (line) => journal.push(line),
    ...(requestedBy ? { requestedBy } : {}),
  });
}

test("the item records the agent's reason and refuses a second re-run of the same commit", async () => {
  const db = database();
  insertQueuedItem(db, { id: "item" });
  const github = fakeGitHub();
  const journal: string[] = [];
  const reason = "runner-session-helpers timed out at 30 s; this change touches only docs";
  expect(await rerun(db, github.client, journal, reason)).toContain("41545628595");
  expect(await rerun(db, github.client, journal, "again")).toBe(CI_ALREADY_RERUN);
  expect(github.posts).toEqual(["/repos/owner/repo/actions/runs/41545628595/rerun-failed-jobs"]);
  expect(await listCiReruns(sqliteDb(db), "item")).toEqual([
    { itemId: "item", head, runIds: [41545628595], reason, at: 1_000 },
  ]);
  expect(journal).toEqual([
    `item PAS-1 CI re-run requested by the agent on ccccccc, workflow run 41545628595: ${JSON.stringify(reason)}`,
  ]);
});

test("a 403 from GitHub answers with the permission message and leaves the item alone", async () => {
  const db = database();
  const before = insertQueuedItem(db, { id: "item" });
  const journal: string[] = [];
  const answer = await rerun(db, fakeGitHub(403).client, journal, "flaky shard");
  expect(answer.startsWith(CI_RERUN_PERMISSION_MISSING)).toBe(true);
  expect(answer).toContain("with status 403");
  expect(await listCiReruns(sqliteDb(db), "item")).toEqual([]);
  expect(journal).toEqual([]);
  const after = getWorkItem(db, "item");
  expect(after?.state).toBe(before.state);
  expect(after?.version).toBe(before.version);
});

test("Paws's own re-run names Paws in the journal", async () => {
  const db = database();
  insertQueuedItem(db, { id: "item" });
  const journal: string[] = [];
  await rerun(db, fakeGitHub().client, journal, "cancelled or timed-out CI job", "Paws");
  expect(journal).toEqual([
    'item PAS-1 CI re-run requested by Paws on ccccccc, workflow run 41545628595: "cancelled or timed-out CI job"',
  ]);
});
