import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitPolicyMessage,
  policyCoauthors,
  policyPullRequestCredit,
  type GitCommitPolicy,
} from "../src/core";
import { commitCheckpointSync, git, runAgent, validateCandidateAttribution } from "../src/acp";
import { createRunnerRepositories } from "../src/runner-repositories";
import {
  beginImplementRun,
  insertQueuedItem,
  migrate,
  openDatabase,
  saveRunCommitPolicy,
  getRun,
  getItemRunCommitPolicy,
  insertRun,
} from "../src/db";
import type { RunnerCommand } from "../src/runner-protocol";

const credit = {
  id: 8,
  login: "steerer",
  name: "Task Steerer",
  email: "8+steerer@users.noreply.github.com",
};
const policy: GitCommitPolicy = { bot: { appId: "99", id: 88, login: "paws-test[bot]" }, credit };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the policy credits exactly the delegating member with one trailer and one PR line", () => {
  expect(policyCoauthors(policy)).toEqual([credit]);
  expect(commitPolicyMessage("change", policy)).toBe(
    "change\n\nCo-authored-by: Task Steerer <8+steerer@users.noreply.github.com>\n",
  );
  expect(policyPullRequestCredit(policy)).toBe("Credit: [@steerer](https://github.com/steerer)");
  expect(() => policyCoauthors({ ...policy, credit: undefined! })).toThrow(
    "Invalid verified GitHub coauthor",
  );
  expect(() => policyCoauthors({ ...policy, credit: { ...credit, login: "-bad" } })).toThrow(
    "Invalid verified GitHub coauthor",
  );
  expect(() =>
    policyCoauthors({ ...policy, credit: { ...credit, email: "not an email" } }),
  ).toThrow();
});

test("bot-only policy omits human credit and still rejects malformed identities", () => {
  const botOnly = { ...policy, credit: null };
  expect(policyCoauthors(botOnly)).toEqual([]);
  expect(commitPolicyMessage("change", botOnly)).toBe("change\n");
  expect(policyPullRequestCredit(botOnly)).toBe("");
  expect(() => policyCoauthors({ ...botOnly, bot: { ...policy.bot, id: 0 } })).toThrow();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-attribution-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const tree = join(root, "tree");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Original Human",
    GIT_AUTHOR_EMAIL: "human@example.invalid",
    GIT_COMMITTER_NAME: "Ambient VM",
    GIT_COMMITTER_EMAIL: "vm@example.invalid",
  };
  const invoke = (args: string[]) => git(["-C", tree, ...args], { env });
  await git(["init", "-b", "main", tree], { env });
  writeFileSync(join(tree, "base"), "ancestor");
  await invoke(["add", "."]);
  await invoke(["commit", "-m", "base"]);
  const base = (await invoke(["rev-parse", "HEAD"])).trim();
  return { root, home, tree, env, invoke, base };
}

async function agent(
  f: Awaited<ReturnType<typeof fixture>>,
  override = false,
  commitPolicy = policy,
) {
  const script = join(f.root, `script-${override}.json`);
  writeFileSync(
    script,
    JSON.stringify({
      model: "fixture-model",
      steps: [
        { type: "fs_write", path: "change", content: "new" },
        { type: "terminal", command: "git", args: ["add", "."] },
        {
          type: "terminal",
          command: "git",
          args: [
            "commit",
            ...(override ? ["--author=Imposter <wrong@example.invalid>"] : []),
            "-m",
            commitPolicyMessage("agent commit", commitPolicy),
          ],
        },
        { type: "end" },
      ],
    }),
  );
  return runAgent({
    role: "implementer",
    profile: { agent: "claude", model: "fixture-model" },
    itemId: "item",
    runId: "run",
    worktreePath: f.tree,
    pawsRoot: join(f.root, "paws"),
    home: f.home,
    env: f.env,
    command: process.execPath,
    args: [
      join(import.meta.dir, "../src/acp/testing/fake-agent.ts"),
      join(f.root, `result-${override}.json`),
      script,
    ],
    prompt: "Implement",
    commitPolicy,
  });
}

test("real ACP normal agent commit and recovery checkpoint share bot and one human trailer", async () => {
  const f = await fixture();
  const result = await agent(f);
  expect(result.errorMessage).toBeUndefined();
  const transcript = JSON.parse(await Bun.file(join(f.root, "result-false.json")).text());
  expect(JSON.stringify(transcript.prompts)).toContain(
    "Include these exact human attribution trailers",
  );
  const first = (await f.invoke(["rev-parse", "HEAD"])).trim();
  await validateCandidateAttribution(f.tree, f.base, first, policy, f.env);
  writeFileSync(join(f.tree, "repair"), "checkpoint");
  const recovery = commitCheckpointSync(f.tree, "repair", undefined, policy);
  await validateCandidateAttribution(f.tree, f.base, recovery.sha!, policy, f.env);
  expect((await f.invoke(["show", "-s", "--format=%an", f.base])).trim()).toBe("Original Human");
  expect(
    (await f.invoke(["log", "--format=%B", `${f.base}..HEAD`])).match(/Co-authored-by:/g),
  ).toHaveLength(2);
});

test("bot-only ACP commits and checkpoints validate without granting unconsented credit", async () => {
  const f = await fixture();
  const botOnly = { ...policy, credit: null };
  const result = await agent(f, false, botOnly);
  expect(result.errorMessage).toBeUndefined();
  const transcript = JSON.parse(await Bun.file(join(f.root, "result-false.json")).text());
  expect(JSON.stringify(transcript.prompts)).toContain("Do not add human Co-authored-by trailers");
  writeFileSync(join(f.tree, "repair"), "checkpoint");
  const checkpoint = commitCheckpointSync(f.tree, "repair", undefined, botOnly);
  await validateCandidateAttribution(f.tree, f.base, checkpoint.sha!, botOnly, f.env);
  expect(await f.invoke(["log", "--format=%B", `${f.base}..HEAD`])).not.toContain(
    "Co-authored-by:",
  );
  await git(["-C", f.tree, "commit", "--amend", "-m", commitPolicyMessage("unconsented", policy)], {
    env: {
      ...f.env,
      GIT_AUTHOR_NAME: "paws-test[bot]",
      GIT_AUTHOR_EMAIL: "88+paws-test[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "paws-test[bot]",
      GIT_COMMITTER_EMAIL: "88+paws-test[bot]@users.noreply.github.com",
    },
  });
  const head = (await f.invoke(["rev-parse", "HEAD"])).trim();
  await expect(validateCandidateAttribution(f.tree, f.base, head, botOnly, f.env)).rejects.toThrow(
    "attribution rejected",
  );
  expect((await f.invoke(["rev-parse", "HEAD"])).trim()).toBe(head);
});

test("explicit agent overrides reject without rewriting any candidate SHA", async () => {
  const f = await fixture();
  const result = await agent(f, true);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Repair metadata before verification");
  const head = (await f.invoke(["rev-parse", "HEAD"])).trim();
  await expect(validateCandidateAttribution(f.tree, f.base, head, policy, f.env)).rejects.toThrow();
  expect((await f.invoke(["rev-parse", "HEAD"])).trim()).toBe(head);
});

test("protected helper rejects a bad intermediate commit even with a valid final checkpoint before write token", async () => {
  const f = await fixture();
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: "command",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1000,
    expiresAt: 2000,
    type: "run",
    runId: "run",
    itemId: "item",
    generation: 1,
    repository: {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
      baseSha: f.base,
    },
    profile: { agent: "claude", model: null },
    prompt: "Implement",
    commitPolicy: policy,
  };
  const accesses: string[] = [];
  const repositories = createRunnerRepositories({
    root: join(f.root, "cache"),
    home: f.home,
    credential: async (_, access) => {
      accesses.push(access);
      return "synthetic";
    },
    networkGit: async (input) => {
      if (input.operation !== "clone") throw new Error("Unexpected publication");
      await git(["clone", "--bare", f.tree, input.dest!], { env: f.env });
    },
  });
  await repositories.prepare(command);
  await agent(f, true);
  writeFileSync(join(f.tree, "repair"), "new valid tip");
  const checkpoint = commitCheckpointSync(f.tree, "tip", undefined, policy);
  const bundle = join(f.root, "candidate.bundle");
  await f.invoke(["bundle", "create", bundle, "HEAD", `^${f.base}`]);
  await expect(
    repositories.publish(command, {
      sha: checkpoint.sha!,
      branch: "paws/item",
      bundle: Buffer.from(await Bun.file(bundle).arrayBuffer()),
    }),
  ).rejects.toThrow("attribution rejected");
  expect(accesses).toEqual(["read"]);
  expect((await f.invoke(["rev-parse", "HEAD"])).trim()).toBe(checkpoint.sha!);
});

test("run attribution snapshot persists across reopen and cannot switch repair identities", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-policy-db-"));
  roots.push(root);
  const path = join(root, "paws.sqlite");
  let db = openDatabase(path);
  migrate(db);
  const item = insertQueuedItem(db, { id: "item", now: 1 });
  const { run } = beginImplementRun(db, item.id, 1);
  saveRunCommitPolicy(db, run.id, policy);
  db.close();
  db = openDatabase(path);
  try {
    expect(getRun(db, run.id)?.checkpoint?.commitPolicy).toEqual(policy);
    insertRun(db, { itemId: item.id, now: 2 });
    expect(getItemRunCommitPolicy(db, item.id)).toEqual(policy);
    expect(() =>
      saveRunCommitPolicy(db, run.id, { ...policy, credit: { ...credit, id: 9 } }),
    ).toThrow("cannot change");
  } finally {
    db.close();
  }
});

test("a run stored with the old lead and steerer policy keeps crediting only the steerer", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const item = insertQueuedItem(db, { id: "item", now: 1 });
    const { run } = beginImplementRun(db, item.id, 1);
    db.run("UPDATE run SET checkpoint=? WHERE id=?", [
      JSON.stringify({
        phase: "running",
        commitPolicy: {
          bot: policy.bot,
          projectLead: { ...credit, id: 7, login: "lead" },
          taskSteerer: credit,
        },
      }),
      run.id,
    ]);
    expect(getItemRunCommitPolicy(db, item.id)).toEqual(policy);
    saveRunCommitPolicy(db, run.id, policy);
    db.run("UPDATE run SET checkpoint=? WHERE id=?", [
      JSON.stringify({ phase: "running", commitPolicy: { bot: policy.bot, projectLead: null } }),
      run.id,
    ]);
    expect(getRun(db, run.id)?.checkpoint?.commitPolicy).toEqual({ bot: policy.bot, credit: null });
  } finally {
    db.close();
  }
});

test("an agent rebase onto the run's main passes attribution only when that main is named", async () => {
  const f = await fixture();
  expect((await agent(f)).errorMessage).toBeUndefined();
  const head = (await f.invoke(["rev-parse", "HEAD"])).trim();
  await f.invoke(["checkout", "-q", "-b", "upstream", f.base]);
  writeFileSync(join(f.tree, "upstream"), "moved main");
  await f.invoke(["add", "."]);
  await f.invoke(["commit", "-m", "moved main"]);
  const main = (await f.invoke(["rev-parse", "HEAD"])).trim();
  const rebase = async (mainSha?: string) => {
    await f.invoke(["checkout", "-q", "-B", "main", head]);
    const script = join(f.root, `rebase-${mainSha ?? "none"}.json`);
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [{ type: "terminal", command: "git", args: ["rebase", main] }, { type: "end" }],
      }),
    );
    return runAgent({
      role: "implementer",
      profile: { agent: "claude", model: "fixture-model" },
      itemId: "item",
      runId: `rebase-${mainSha ?? "none"}`,
      worktreePath: f.tree,
      pawsRoot: join(f.root, "paws"),
      home: f.home,
      env: f.env,
      command: process.execPath,
      args: [
        join(import.meta.dir, "../src/acp/testing/fake-agent.ts"),
        join(f.root, `rebase-result-${mainSha ?? "none"}.json`),
        script,
      ],
      prompt: "Rebase onto main",
      commitPolicy: policy,
      ...(mainSha ? { mainSha } : {}),
    });
  };
  expect({
    withoutMain: (await rebase()).errorMessage !== undefined,
    withMain: (await rebase(main)).errorMessage ?? null,
  }).toEqual({ withoutMain: true, withMain: null });
});
