import { afterEach, expect, test } from "bun:test";
import {
  createDeployLagCheck,
  deployLagUnavailable,
  readAlerts,
  runningRevisionContains,
} from "../src/alerts";
import { registerInstanceSteps, type Db } from "../src/db";
import { githubSourceRepository, type GitHubClient } from "../src/github";
import { seed, withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 27, 20, 0, 0);
const tokenProvider = { mode: "app" as const, tokenFor: async () => "ghs_test" };
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function store(version: string | null): Promise<Db> {
  const opened = await tempStore();
  closers.push(opened.close);
  await withoutForeignKeys(opened.db);
  await opened.db.run((q) =>
    registerInstanceSteps(q, { role: "all", host: "agentbox", version, now: NOW - 1_000 }),
  );
  return opened.db;
}

function fakeGitHub(input: {
  access?: boolean;
  missing?: number[];
  release?: { tag: string; at: number };
}) {
  const calls: string[] = [];
  const client: GitHubClient = {
    async request({ path }) {
      calls.push(path);
      const route = path.replace("/repos/pmdroid/paws-app", "");
      if (input.access === false) return { status: 404, body: { message: "Not Found" } };
      if (route === "") return { status: 200, body: { default_branch: "main" } };
      if (route === "/releases/latest")
        return input.release
          ? {
              status: 200,
              body: { tag_name: input.release.tag, published_at: iso(input.release.at) },
            }
          : { status: 404, body: {} };
      const missing = input.missing ?? [];
      if (!route.endsWith("...main"))
        return {
          status: 200,
          body: { status: /^\/compare\/c\d/.test(route) ? "behind" : "identical", commits: [] },
        };
      return {
        status: 200,
        body: {
          status: missing.length === 0 ? "identical" : "ahead",
          ahead_by: missing.length,
          commits: missing.map((at, index) => ({
            sha: `c${index}`,
            commit: { committer: { date: iso(at) } },
          })),
        },
      };
    },
  };
  const repository = { owner: "pmdroid", repo: "paws-app" };
  const source = githubSourceRepository(repository, () => ({
    ...repository,
    client,
    tokenProvider,
  }));
  return { calls, source };
}

const clock = () => NOW;
const iso = (at: number) => new Date(at).toISOString();

test("a running revision three commits behind, the oldest five hours old, raises a warning", async () => {
  const db = await store("git:4de272a06abc");
  const github = fakeGitHub({ missing: [NOW - 5 * HOUR, NOW - 3 * HOUR, NOW - HOUR] });
  const check = createDeployLagCheck(db, github.source, clock);
  const alerts = await readAlerts(db, NOW, check);
  expect(alerts).toEqual([
    {
      id: "deploy_lag:4de272a06abc",
      severity: "warning",
      title: "The running Paws lacks 3 commits from main",
      detail:
        "4de272a06abc lacks 3 commits on pmdroid/paws-app main; the oldest was committed 5 h ago.",
      since: NOW - 5 * HOUR,
      count: 3,
    },
  ]);
  await readAlerts(db, NOW, check);
  expect(github.calls.filter((path) => path.includes("/compare/"))).toEqual([
    "/repos/pmdroid/paws-app/compare/4de272a06abc...main",
  ]);
  expect(await runningRevisionContains(check, "c0")).toBe(false);
});

test("a lag older than a day is critical", async () => {
  const db = await store("0.1.108");
  const check = createDeployLagCheck(db, fakeGitHub({ missing: [NOW - 25 * HOUR] }).source, clock);
  expect((await readAlerts(db, NOW, check)).map((alert) => [alert.id, alert.severity])).toEqual([
    ["deploy_lag:v0.1.108", "critical"],
  ]);
});

test("a current revision raises nothing", async () => {
  const db = await store("git:4de272a06abc");
  const check = createDeployLagCheck(db, fakeGitHub({}).source, clock);
  expect(await readAlerts(db, NOW, check)).toEqual([]);
  expect(await runningRevisionContains(check, "4de272a06abc")).toBe(true);
});

test("without App access there is no alert and the doctor notes it", async () => {
  const db = await store("git:4de272a06abc");
  const github = fakeGitHub({ access: false, missing: [NOW - 5 * HOUR] });
  const check = createDeployLagCheck(db, github.source, clock);
  expect(await readAlerts(db, NOW, check)).toEqual([]);
  expect(await runningRevisionContains(check, "c0")).toBeNull();
  expect(await deployLagUnavailable(check, NOW)).toStartWith(
    "the GitHub App can't read pmdroid/paws-app",
  );
});

test("an unknown source repository turns the check off", async () => {
  const db = await store("git:4de272a06abc");
  expect(await readAlerts(db, NOW, createDeployLagCheck(db, null, clock))).toEqual([]);
});

test("a runner below the latest release for five hours raises runner_behind", async () => {
  const db = await store(null);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values([
        {
          id: "runner-1",
          workspaceId: "ws-1",
          ownerUserId: "u",
          name: "old",
          status: "active",
          createdAt: 0,
        },
        {
          id: "runner-2",
          workspaceId: "ws-1",
          ownerUserId: "u",
          name: "new",
          status: "active",
          createdAt: 0,
        },
      ]),
    (q) =>
      q.orm.insert(q.t.runnerHostStatus).values([
        { runnerId: "runner-1", runnerVersion: "0.1.108", reportedAt: NOW },
        { runnerId: "runner-2", runnerVersion: "0.1.109", reportedAt: NOW },
      ]),
  );
  const github = fakeGitHub({ release: { tag: "v0.1.109", at: NOW - 5 * HOUR } });
  expect(await readAlerts(db, NOW, createDeployLagCheck(db, github.source, clock))).toEqual([
    {
      id: "runner_behind:runner-1",
      severity: "warning",
      title: "Runner old runs 0.1.108, below release 0.1.109",
      detail: "0.1.109 was published 5 h ago.",
      since: NOW - 5 * HOUR,
      count: 1,
    },
  ]);
  const fresh = fakeGitHub({ release: { tag: "v0.1.109", at: NOW - 3 * HOUR } });
  expect(await readAlerts(db, NOW, createDeployLagCheck(db, fresh.source, clock))).toEqual([]);
});
