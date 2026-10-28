import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { git } from "../src/acp";
import { createRunnerRepositories } from "../src/runner-repositories";
import type { RunnerCommand } from "../src/runner-protocol";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BRANCH = "paws/item-1";

/** A local bare repository stands in for GitHub; pushes go through it like the real transport. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-candidate-rebase-"));
  roots.push(root);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (args: string[]) => git(args, { env });
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  await run(["init", "-b", "main", source]);
  writeFileSync(join(source, "shared.txt"), "one\ntwo\nthree\n");
  await run(["-C", source, "add", "."]);
  await run(["-C", source, "commit", "-m", "base"]);
  const baseSha = (await run(["-C", source, "rev-parse", "HEAD"])).trim();
  await run(["clone", "--bare", source, origin]);
  const commit = async (file: string, body: string, message: string) => {
    writeFileSync(join(source, file), body);
    await run(["-C", source, "add", "."]);
    await run(["-C", source, "commit", "-m", message]);
    return (await run(["-C", source, "rev-parse", "HEAD"])).trim();
  };
  const now = Date.now();
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: randomUUID(),
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + 60_000,
    type: "run",
    runId: randomUUID(),
    itemId: randomUUID(),
    generation: 1,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha,
    },
    profile: { agent: "claude", model: null },
    prompt: "Implement the task.",
  };
  const pushes: { refspec: string; lease?: string }[] = [];
  const repositories = createRunnerRepositories({
    root: join(root, "cache"),
    home: root,
    credential: async (_command, access) => `fixture-${access}`,
    async networkGit(input) {
      if (input.operation === "clone")
        await run(["clone", "--bare", origin, resolve(input.cwd, input.dest!)]);
      else if (input.operation === "fetch")
        await run(["--git-dir", input.dest!, "fetch", origin, "+refs/heads/*:refs/heads/*"]);
      else {
        pushes.push({ refspec: input.refspec!, ...(input.lease ? { lease: input.lease } : {}) });
        await run([
          "--git-dir",
          input.cwd,
          "push",
          ...(input.lease
            ? [`--force-with-lease=${input.refspec!.split(":")[1]}:${input.lease}`]
            : []),
          origin,
          input.refspec!,
        ]);
      }
    },
  });
  await repositories.prepare(command);
  /** The candidate the agent made from `from`: its bundle, as the worker writes it. */
  const candidate = async (from: string, file: string, body: string) => {
    await run(["-C", source, "checkout", "-q", "--detach", from]);
    const sha = await commit(file, body, `agent: ${file}`);
    const bundle = join(root, `${sha}.bundle`);
    await run(["-C", source, "bundle", "create", bundle, "HEAD", `^${baseSha}`]);
    return { sha, bundle: readFileSync(bundle), branch: BRANCH };
  };
  /** A head of the item that already reached GitHub from an earlier run. */
  const remoteHead = async (file: string, body: string) => {
    await run(["-C", source, "checkout", "-q", "--detach", baseSha]);
    const sha = await commit(file, body, `earlier run: ${file}`);
    await run(["-C", source, "push", "-q", origin, `${sha}:refs/heads/${BRANCH}`]);
    return sha;
  };
  const branchSha = async (branch = BRANCH) =>
    (await run(["--git-dir", origin, "rev-parse", `refs/heads/${branch}`])).trim();
  const contains = (older: string, newer: string) =>
    run(["--git-dir", origin, "merge-base", "--is-ancestor", older, newer]).then(
      () => true,
      () => false,
    );
  const show = async (sha: string, file: string) =>
    run(["--git-dir", origin, "show", `${sha}:${file}`]);
  return {
    command,
    repositories,
    pushes,
    baseSha,
    candidate,
    remoteHead,
    branchSha,
    contains,
    show,
    run,
    origin,
  };
}

test("a candidate that contains the branch tip is pushed with a lease on that tip", async () => {
  const f = await fixture();
  const earlier = await f.remoteHead("earlier.txt", "earlier\n");
  const next = await f.candidate(earlier, "next.txt", "next\n");

  assert.deepEqual(await f.repositories.publish(f.command, next, undefined, undefined, true), {
    sha: next.sha,
  });
  assert.equal(await f.branchSha(), next.sha);
  assert.deepEqual(f.pushes, [{ refspec: `${next.sha}:refs/heads/${BRANCH}`, lease: earlier }]);
}, 30_000);

test("a candidate missing the branch tip is rebased onto it and pushed", async () => {
  const f = await fixture();
  const earlier = await f.remoteHead("earlier.txt", "earlier\n");
  const stale = await f.candidate(f.baseSha, "next.txt", "next\n");

  const published = await f.repositories.publish(f.command, stale, undefined, undefined, true);

  assert("sha" in published);
  assert.equal(published.rebasedFrom, stale.sha);
  assert.notEqual(published.sha, stale.sha);
  const head = await f.branchSha();
  assert.equal(head, published.sha);
  assert(await f.contains(earlier, head), "the earlier head stays on the branch");
  assert.equal(await f.show(head, "earlier.txt"), "earlier\n");
  assert.equal(await f.show(head, "next.txt"), "next\n");
  assert.equal(
    (await f.run(["--git-dir", f.origin, "show", "-s", "--format=%an %s", head])).trim(),
    "Fixture agent: next.txt",
  );
  assert.deepEqual(f.pushes, [{ refspec: `${head}:refs/heads/${BRANCH}`, lease: earlier }]);

  // Publishing the same candidate again, as a retry does, finds its work already there.
  assert.deepEqual(await f.repositories.publish(f.command, stale, undefined, undefined, true), {
    sha: head,
    rebasedFrom: stale.sha,
  });
  assert.equal(f.pushes.length, 1);
}, 30_000);

test("a conflicting candidate waits on its side branch and the branch keeps its commits", async () => {
  const f = await fixture();
  const earlier = await f.remoteHead("shared.txt", "one\nremote\nthree\n");
  const stale = await f.candidate(f.baseSha, "shared.txt", "one\nagent\nthree\n");

  const published = await f.repositories.publish(f.command, stale, undefined, undefined, true);

  assert.deepEqual(published, {
    conflict: { branch: `${BRANCH}-conflict`, sha: stale.sha, tip: earlier, files: ["shared.txt"] },
  });
  assert.equal(await f.branchSha(), earlier, "the remote-only commit is not overwritten");
  assert.equal(await f.branchSha(`${BRANCH}-conflict`), stale.sha);
  assert.deepEqual(f.pushes, [{ refspec: `${stale.sha}:refs/heads/${BRANCH}-conflict` }]);
}, 30_000);

test("a WIP checkpoint never replaces commits it does not contain", async () => {
  const f = await fixture();
  const earlier = await f.remoteHead("earlier.txt", "earlier\n");
  const checkpoint = await f.candidate(f.baseSha, "wip.txt", "wip\n");

  await assert.rejects(
    f.repositories.publish(f.command, checkpoint),
    /which this commit does not contain/,
  );
  assert.equal(await f.branchSha(), earlier);
  assert.deepEqual(f.pushes, []);
}, 30_000);

test("a conflict round rebased onto the branch tip is pushed and retires the side branch", async () => {
  const f = await fixture();
  const earlier = await f.remoteHead("shared.txt", "one\nremote\nthree\n");
  const stale = await f.candidate(f.baseSha, "shared.txt", "one\nagent\nthree\n");
  await f.repositories.publish(f.command, stale, undefined, undefined, true);
  // The next turn starts from the parked candidate with the branch tip as origin/<branch>.
  const round: Extract<RunnerCommand, { type: "run" }> = {
    ...f.command,
    id: randomUUID(),
    generation: 2,
    repository: {
      ...f.command.repository,
      baseSha: stale.sha,
      branchName: BRANCH,
      branchSha: earlier,
    },
  };
  await f.repositories.prepare(round);
  // The agent resolved the conflict on top of the tip.
  const resolved = await f.candidate(earlier, "shared.txt", "one\nremote and agent\nthree\n");

  assert.deepEqual(await f.repositories.publish(round, resolved, undefined, undefined, true), {
    sha: resolved.sha,
  });
  assert.equal(await f.branchSha(), resolved.sha);
  await assert.rejects(f.branchSha(`${BRANCH}-conflict`));
  assert.deepEqual(f.pushes.slice(-2), [
    { refspec: `${resolved.sha}:refs/heads/${BRANCH}`, lease: earlier },
    { refspec: `:refs/heads/${BRANCH}-conflict`, lease: stale.sha },
  ]);
}, 30_000);
