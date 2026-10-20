import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { git } from "../../src/acp";
import { fetchRunnerCandidate } from "../../src/runner-backend";

export async function probeRunnerCandidate(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (args: string[]) => git(args, { env });
  const source = join(root, "publisher"),
    remote = join(root, "remote.git"),
    worktree = join(root, "task");
  await run(["init", "-b", "main", source]);
  writeFileSync(join(source, "result.txt"), "base");
  await run(["-C", source, "add", "."]);
  await run(["-C", source, "commit", "-m", "Base"]);
  const baseSha = (await run(["-C", source, "rev-parse", "HEAD"])).trim();
  await run(["clone", "--bare", source, remote]);
  await run(["clone", "--no-hardlinks", remote, worktree]);
  writeFileSync(join(source, "result.txt"), "candidate");
  await run(["-C", source, "commit", "-am", "Candidate"]);
  const candidateSha = (await run(["-C", source, "rev-parse", "HEAD"])).trim();
  await run(["-C", source, "push", remote, "HEAD:refs/heads/candidate"]);
  await run(["-C", source, "checkout", "--orphan", "unrelated"]);
  await run(["-C", source, "commit", "-am", "Unrelated"]);
  const unrelated = (await run(["-C", source, "rev-parse", "HEAD"])).trim();
  await run(["-C", source, "push", remote, "HEAD:refs/heads/unrelated"]);
  const remoteUrl = "https://github.com/fixture/repository.git";
  const calls: string[][] = [];
  const networkGit = async (args: string[]) => {
    calls.push(args);
    assert.equal(args.at(-2), remoteUrl);
    const local = [...args];
    local[local.length - 2] = remote;
    return run(local);
  };
  const input = {
    worktree,
    baseSha,
    candidateSha,
    branch: "candidate",
    remoteUrl,
    networkGit,
    signal: new AbortController().signal,
  };
  const head = async () => (await run(["-C", worktree, "rev-parse", "HEAD"])).trim();
  const retained = async () => {
    assert.equal(await head(), baseSha);
    assert.equal(readFileSync(join(worktree, "result.txt"), "utf8"), "base");
    assert.equal((await run(["-C", worktree, "for-each-ref", "refs/paws/candidates"])).trim(), "");
  };
  await assert.rejects(run(["-C", worktree, "cat-file", "-e", candidateSha]));
  await fetchRunnerCandidate(input);
  assert.equal(await head(), candidateSha);
  assert.equal(readFileSync(join(worktree, "result.txt"), "utf8"), "candidate");
  assert.equal((await run(["-C", worktree, "for-each-ref", "refs/paws/candidates"])).trim(), "");
  observe("exact descendant imports through the canonical credential-scoped network port", true, {
    baseSha,
    candidateSha,
    networkRemote: calls[0]!.at(-2),
  });
  await run(["-C", worktree, "reset", "--hard", baseSha]);
  await assert.rejects(
    fetchRunnerCandidate({ ...input, candidateSha: unrelated, branch: "unrelated" }),
  );
  await retained();
  observe("unrelated fetched commit is rejected before changing the task checkout", true, {
    head: await head(),
  });
  await run(["-C", source, "push", "--force", remote, "HEAD:refs/heads/candidate"]);
  await assert.rejects(fetchRunnerCandidate(input), /does not match/);
  await retained();
  await run(["-C", source, "push", "--force", remote, `${candidateSha}:refs/heads/candidate`]);
  observe("a moved publication branch cannot import a different reported candidate", true, {
    head: await head(),
  });
  await assert.rejects(fetchRunnerCandidate({ ...input, branch: "missing" }));
  await assert.rejects(
    fetchRunnerCandidate({ ...input, candidateSha: "a".repeat(40) }),
    /does not match/,
  );
  await retained();
  observe(
    "missing publication branch and wrong reported SHA preserve the base and clear private refs",
    true,
    {},
  );
  const count = calls.length;
  await assert.rejects(fetchRunnerCandidate({ ...input, candidateSha: "HEAD" }), /invalid/);
  await assert.rejects(fetchRunnerCandidate({ ...input, networkGit: undefined! }), /invalid/);
  await assert.rejects(fetchRunnerCandidate({ ...input, branch: "candidate:other" }));
  assert.equal(calls.length, count);
  await retained();
  observe("invalid candidate and absent authorized network port fail before fetching", true, {
    networkCalls: calls.length,
  });
  await assert.rejects(
    fetchRunnerCandidate({ ...input, branch: "missing" }),
    /could not import the runner's commit [a-f0-9]{7} from missing: /,
  );
  const fetches = calls.length;
  await fetchRunnerCandidate({ ...input, candidateSha: baseSha, branch: "missing" });
  assert.equal(calls.length, fetches);
  await retained();
  observe("a candidate equal to the base is already checked out and is not fetched", true, {
    networkCalls: calls.length,
  });
  const controller = new AbortController();
  const cancelled = fetchRunnerCandidate({
    ...input,
    signal: controller.signal,
    networkGit: async () => {
      controller.abort();
      await delay(1, undefined, { signal: controller.signal });
      return "";
    },
  });
  await assert.rejects(cancelled, /abort/i);
  await retained();
  observe("cancellation during the network operation never checks out a candidate", true, {});
  await assert.rejects(
    fetchRunnerCandidate({
      ...input,
      networkGit: async (args) => {
        await networkGit(args);
        await run(["-C", worktree, "reset", "--hard", unrelated]);
        return "";
      },
    }),
    /base changed/,
  );
  assert.equal(await head(), unrelated);
  observe("a concurrently changed task HEAD is retained rather than overwritten", true, {
    head: await head(),
  });
}
