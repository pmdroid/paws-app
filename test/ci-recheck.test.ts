import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, spyOn, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import * as closeoutCommands from "../src/closeout-spec/run/exec";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, listJobs, migrate, openDatabase } from "../src/db";
import {
  createFakeGitHub,
  fakeMergeReadiness,
  type FakeCheckContext,
  type GitHubResponse,
} from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import {
  CLOSEOUT_POLICY,
  emptyReview,
  gitIdentity,
  githubClient,
  isMergeReadiness,
  repoLayout,
  stateOf,
  writeOk,
} from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { tickWithRestarts } from "./helpers";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const RUNS = "https://github.com/pmdroid/paws-demo/actions/runs";

/** The e2e policy with its `test` check mapped to the CI shards. */
const POLICY = CLOSEOUT_POLICY.replace(
  "    timeoutSeconds: 60\n",
  '    timeoutSeconds: 60\n    ci: "test (*)"\n',
);

const shard = (index: number, conclusion: string | null, run: number): FakeCheckContext => ({
  name: `test (${index}/2)`,
  conclusion,
  detailsUrl: `${RUNS}/${run}/job/${run * 10 + index}`,
});

/**
 * One task through the merge queue. CI fails on the first accepted head, so the lane sends it
 * back. CI fails again on the fix, so the re-check sends it back without running Closeout. On
 * the third head CI is pending, then green: the re-check waits, takes `test` from CI and runs
 * only the review. The third head would fail `test` if it ran.
 */
test("a merge-queue re-check waits for CI, sends red CI to a fix and takes green CI's results", async () => {
  const layout = await repoLayout("paws-ci-recheck-");
  await commitPolicy(layout.bare);
  const tracker = createFakeTracker([
    {
      linearIssueId: "recheck",
      identifier: "ENG-8",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock, { backoffBaseMs: 10 });
  const outbox = new OutboxDispatcher(db, systemClock);
  const client = githubClient(layout.bare, createFakeGitHub());
  const heads: string[] = [];
  const reads = new Map<string, number>();
  const ci = (head: string): GitHubResponse => {
    if (!heads.includes(head)) heads.push(head);
    const read = (reads.get(head) ?? 0) + 1;
    reads.set(head, read);
    const nth = heads.indexOf(head);
    const checks =
      nth < 2
        ? [shard(0, "FAILURE", nth + 1), shard(1, "SUCCESS", nth + 1)]
        : [shard(0, read === 1 ? null : "SUCCESS", 3), shard(1, "SUCCESS", 3)];
    const body = fakeMergeReadiness(head);
    body.data.repository.object.statusCheckRollup.contexts.nodes = checks;
    return { status: 200, body };
  };
  const ran: string[] = [];
  const realCommands = closeoutCommands.createCommandRunner;
  const commands = spyOn(closeoutCommands, "createCommandRunner").mockImplementation((options) => {
    const runner = realCommands(options);
    return {
      ...runner,
      async runLogged(request) {
        ran.push(`${request.itemId}@${request.expectedHead}`);
        return runner.runLogged(request);
      },
    };
  });
  const journal: string[] = [];
  let turns = 0;
  let reviews = 0;
  let sequence = 0;
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    retryBaseMs: 10,
    journal: (line) => journal.push(line),
    ciRecheckWait: { pollMs: 10, maxWaitMs: 60_000 },
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: {
        async request(req): Promise<GitHubResponse> {
          if (isMergeReadiness(req))
            return ci((req.body as { variables: { head: string } }).variables.head);
          return client.request(req);
        },
      },
    }),
    launch(input) {
      sequence += 1;
      let steps: FakeScript["steps"] = emptyReview().steps;
      if (input.purpose === "implement") {
        turns += 1;
        const file = turns === 1 ? null : turns === 2 ? "fix.txt" : "header.txt";
        steps = [
          file === null
            ? writeOk(input.worktree)
            : { type: "fs_write", path: path.join(input.worktree, file), content: "fix\n" },
          { type: "end" },
        ];
      } else if (input.purpose === "review") reviews += 1;
      const scriptPath = path.join(layout.root, `recheck-${sequence}.json`);
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
    },
  });
  try {
    await orchestrator.onLinearEvent(linearEvent());
    const deadline = Date.now() + 120_000;
    while (
      Date.now() < deadline &&
      !["failed", "merged", "awaiting_input"].includes(stateOf(db, "ENG-8") ?? "")
    ) {
      if ((await tickWithRestarts(jobs, orchestrator, db)) === null) {
        outbox.tick();
        await Bun.sleep(25);
      }
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const detail = JSON.stringify({
      heads,
      ran,
      jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
      progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
    });
    expect(stateOf(db, "ENG-8"), detail).toBe("merged");
    expect(heads.length, detail).toBe(3);
    const [first, second, third] = heads as [string, string, string];
    expect(turns, detail).toBe(3);
    // A first run runs everything; the red re-check ran nothing; the green one ran no `test`.
    expect(ran, detail).toContain(`test@${first}`);
    expect(
      ran.filter((entry) => !entry.endsWith(first)),
      detail,
    ).toEqual([]);
    expect(reads.get(third), detail).toBeGreaterThanOrEqual(2);
    expect(reviews, detail).toBe(2);
    expect(
      journal.some((line) => line.includes("waits for CI")),
      detail,
    ).toBe(true);
    expect(journal, detail).toContain(
      `item ENG-8 re-check at ${second.slice(0, 7)}: CI: \`test (0/2)\` failed. Sent back to the agent, fix 2 of 3.`,
    );
    const message = await git(layout.bare, ["log", "-1", "--format=%B", "main"]);
    expect(message, detail).toContain(
      `- test (command): passed attempt 1 — from CI run ${RUNS}/3: \`test (0/2)\` success, \`test (1/2)\` success`,
    );
  } finally {
    commands.mockRestore();
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 180_000);

async function commitPolicy(bare: string): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-ci-policy-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    await gitIdentity(tmp);
    await writeFile(path.join(tmp, ".agents", "closeout.yaml"), POLICY);
    await exec("git", ["-C", tmp, "commit", "-am", "map test to CI"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  return (await exec("git", ["-C", dir, ...args])).stdout;
}

function linearEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:recheck",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "recheck",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
