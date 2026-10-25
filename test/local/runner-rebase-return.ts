import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../src/acp";
import {
  appBotCommitIdentity,
  commitIdentityEnv,
  commitPolicyMessage,
  type GitCommitPolicy,
} from "../../src/core";
import { runGitHubGit } from "../../src/github";
import { REBASE_CONFLICT_INSTRUCTION } from "../../src/merge";
import { fetchRunnerCandidate } from "../../src/runner-backend";
import type { RunnerJob } from "../../src/runner-execution";
import type { RunnerCommand } from "../../src/runner-protocol";
import { createRunnerRepositories } from "../../src/runner-repositories";
import { executeRunnerCommand } from "../../src/runner-worker";

const policy: GitCommitPolicy = {
  bot: { appId: "99", id: 88, login: "paws-test[bot]" },
  credit: {
    id: 8,
    login: "steerer",
    name: "Task Steerer",
    email: "8+steerer@users.noreply.github.com",
  },
};

/**
 * A whole rebase-conflict return on a runner with a commit policy: the run's
 * branch conflicts with the main Paws fetched, the agent follows Paws's
 * rebase instruction, and the candidate goes through the runner worker, the
 * runner repository cache and the host import.
 */
export async function probeRunnerRebaseReturn(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  execute: typeof executeRunnerCommand = executeRunnerCommand,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const bot = { ...env, ...commitIdentityEnv(appBotCommitIdentity(policy.bot)) };
  const invoke = (args: string[], as: NodeJS.ProcessEnv = env) => git(args, { env: as });
  const source = join(root, "source");
  const origin = join(root, "github.git");
  const branch = "paws/rebase-return";
  await invoke(["init", "-b", "main", source]);
  const commit = async (file: string, content: string, message: string, as = env) => {
    writeFileSync(join(source, file), content);
    await invoke(["-C", source, "add", "."]);
    await invoke(["-C", source, "commit", "-m", message], as);
    return (await invoke(["-C", source, "rev-parse", "HEAD"])).trim();
  };
  const baseSha = await commit("conflict.txt", "base\n", "base");
  await invoke(["-C", source, "checkout", "-q", "-b", branch]);
  const headSha = await commit(
    "conflict.txt",
    "branch\n",
    commitPolicyMessage("Branch work", policy),
    bot,
  );
  await invoke(["-C", source, "checkout", "-q", "main"]);
  const mainSha = await commit("conflict.txt", "main\n", "Main moved");
  await invoke(["clone", "-q", "--bare", source, origin]);

  const host = join(root, "host");
  await invoke(["clone", "-q", origin, host]);
  await invoke(["-C", host, "checkout", "-q", "-B", branch, headSha]);
  await invoke(["-C", host, "update-ref", "refs/paws/upstream-main", mainSha]);

  const newerSha = await commit("newer.txt", "newer\n", "Main moved again");
  await invoke(["-C", source, "push", "-q", origin, "main"]);

  const remoteUrl = "https://github.com/fixture/repository.git";
  const leases: (string | null)[] = [];
  const repositories = createRunnerRepositories({
    root: join(root, "cache"),
    home,
    async credential(_command, access) {
      return `fixture-${access}`;
    },
    async networkGit(input) {
      assert.equal(input.remoteUrl, remoteUrl);
      if (input.operation === "push") leases.push(input.lease ?? null);
      await runGitHubGit({ ...input, remoteUrl: origin });
    },
  });
  const now = Date.now();
  function job(index: number): RunnerJob & { command: Extract<RunnerCommand, { type: "run" }> } {
    return {
      executionId: `01J${"0".repeat(21)}R${index}`,
      command: {
        id: randomUUID(),
        runnerId: "runner",
        workspaceId: "workspace",
        issuedAt: now,
        expiresAt: now + 60_000,
        type: "run",
        runId: randomUUID(),
        itemId: randomUUID(),
        generation: 2,
        repository: { owner: "fixture", repo: "repository", remoteUrl, baseSha: headSha, mainSha },
        profile: { agent: "claude", model: "fixture-model" },
        prompt: REBASE_CONFLICT_INSTRUCTION,
        commitPolicy: policy,
        checkpointBot: policy.bot,
      },
    };
  }
  const resolve = [
    { type: "fs_write", path: "conflict.txt", content: "resolved\n" },
    { type: "terminal", command: "git", args: ["add", "conflict.txt"] },
  ];
  // What the agent does with the instruction: rebase onto the origin/main Paws
  // fetched, or, as on PAS-432, fetch GitHub itself and merge the newer main.
  const merge = [
    { type: "terminal", command: "git", args: ["fetch", origin, "main"] },
    { type: "terminal", command: "git", args: ["merge", "--no-edit", "FETCH_HEAD"] },
    ...resolve,
    {
      type: "terminal",
      command: "git",
      args: ["commit", "-m", commitPolicyMessage("Merge main", policy)],
    },
  ];
  const rebase = [
    { type: "terminal", command: "git", args: ["rebase", "origin/main"] },
    ...resolve,
    { type: "terminal", command: "git", args: ["-c", "core.editor=true", "rebase", "--continue"] },
  ];
  const followed = /origin\/main without fetching/.test(REBASE_CONFLICT_INSTRUCTION)
    ? rebase
    : merge;
  async function run(index: number, steps: unknown[]) {
    const current = job(index);
    const snapshot = await repositories.prepare(current.command);
    const script = join(root, `script-${index}.json`);
    writeFileSync(
      script,
      JSON.stringify({ model: "fixture-model", steps: [...steps, { type: "end" }] }),
    );
    const outputDirectory = join(root, `output-${index}`);
    mkdirSync(outputDirectory, { mode: 0o750 });
    const result = await execute({
      job: current,
      repositoryBundle: snapshot.bundle,
      outputDirectory,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../../src/acp/testing/fake-agent.ts", import.meta.url)),
          join(root, `agent-${index}.json`),
          script,
        ],
        env,
      },
    });
    return { command: current.command, result, bundle: join(outputDirectory, "candidate.bundle") };
  }

  const rebased = await run(1, followed);
  observe(
    "runAgent's attribution check accepts the rebase onto the run's main",
    rebased.result.run.stopReason === "end_turn" && rebased.result.run.errorMessage === undefined,
    { stopReason: rebased.result.run.stopReason, errorMessage: rebased.result.run.errorMessage },
  );
  const candidateSha = rebased.result.candidateSha;
  assert(
    candidateSha && existsSync(rebased.bundle),
    `The rebased run returned no candidate: ${JSON.stringify(rebased.result)}`,
  );
  await invoke(["-C", source, "fetch", "-q", rebased.bundle, `HEAD:refs/heads/rebased`]);
  const parents = (await invoke(["-C", source, "rev-list", "--parents", "-n1", candidateSha]))
    .trim()
    .split(" ");
  const metadata = (
    await invoke(["-C", source, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", candidateSha])
  ).trim();
  const identity = appBotCommitIdentity(policy.bot);
  observe(
    "the agent rebases the conflicting branch onto the run's main as the App bot",
    parents.length === 2 &&
      parents[1] === mainSha &&
      (await invoke(["-C", source, "show", `${candidateSha}:conflict.txt`])) === "resolved\n" &&
      metadata === `${identity.name} <${identity.email}>\n${identity.name} <${identity.email}>`,
    { candidateSha, parents, metadata },
  );

  await repositories.publish(rebased.command, {
    bundle: readFileSync(rebased.bundle),
    sha: candidateSha,
    branch,
  });
  const published = (await invoke(["--git-dir", origin, "rev-parse", branch])).trim();
  observe(
    "the runner repository cache replaces the branch head with --force-with-lease",
    published === candidateSha && leases.at(-1) === headSha,
    { published, leases },
  );

  await fetchRunnerCandidate({
    worktree: host,
    baseSha: headSha,
    mainSha,
    candidateSha,
    branch,
    remoteUrl,
    networkGit: (args) => {
      assert.equal(args.at(-2), remoteUrl);
      return invoke(args.with(-2, origin));
    },
    signal: AbortSignal.timeout(30_000),
  });
  const imported = (await invoke(["-C", host, "rev-parse", "HEAD"])).trim();
  observe("the host imports the rebased candidate", imported === candidateSha, {
    imported,
    candidateSha,
  });

  const merged = await run(2, merge);
  observe(
    "a merge commit that pulls in a main newer than the run's main fails attribution",
    merged.result.run.stopReason === "error" &&
      /attribution rejected/.test(merged.result.run.errorMessage ?? "") &&
      merged.result.candidateSha === undefined &&
      !existsSync(merged.bundle),
    { result: merged.result, baseSha, newerSha },
  );
}
