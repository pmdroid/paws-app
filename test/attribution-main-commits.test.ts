import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitPatchIds, git, validateCandidateAttribution } from "../src/acp";
import type { GitCommitPolicy } from "../src/core";

const policy: GitCommitPolicy = {
  bot: { appId: "99", id: 88, login: "paws-test[bot]" },
  credit: null,
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const person = { name: "Pascal", email: "434505+pmdroid@users.noreply.github.com" };
const bot = { name: "paws-test[bot]", email: "88+paws-test[bot]@users.noreply.github.com" };

async function repository() {
  const tree = mkdtempSync(join(tmpdir(), "paws-attribution-main-"));
  roots.push(tree);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: tree,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (args: string[], who = person) =>
    git(["-C", tree, ...args], {
      env: {
        ...env,
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
      },
    });
  const commit = async (file: string, message: string, who = person) => {
    writeFileSync(join(tree, file), message);
    await run(["add", "."], who);
    await run(["commit", "-qm", message], who);
    return (await run(["rev-parse", "HEAD"])).trim();
  };
  await run(["init", "-q", "-b", "main"]);
  const base = await commit("base.txt", "Base");
  await commit("main.txt", "A pull request merged by hand on main");
  const main = (await run(["rev-parse", "HEAD"])).trim();
  await run(["checkout", "-q", "-b", "paws/item"]);
  const head = await commit("item.txt", "The item's own work", bot);
  return { tree, env, run, commit, base, main, head };
}

test("a commit already on main doesn't count as the candidate's own commit", async () => {
  const r = await repository();
  await expect(validateCandidateAttribution(r.tree, r.base, r.head, policy, r.env)).rejects.toThrow(
    "attribution rejected",
  );
  await r.run(["update-ref", "refs/paws/upstream-main", r.main]);
  await validateCandidateAttribution(r.tree, r.base, r.head, policy, r.env);
});

test("a person's commit that is only on the branch is still rejected", async () => {
  const r = await repository();
  await r.run(["update-ref", "refs/paws/upstream-main", r.main]);
  const head = await r.commit("sneaky.txt", "A person's commit on the branch");
  await expect(validateCandidateAttribution(r.tree, r.base, head, policy, r.env)).rejects.toThrow(
    "attribution rejected",
  );
});

test("a person's commit Paws adopted passes by patch-id, also after a rebase onto newer main", async () => {
  const r = await repository();
  await r.run(["update-ref", "refs/paws/upstream-main", r.main]);
  const adopted = await r.commit("person.txt", "A person's commit Paws adopted");
  const ids = await commitPatchIds(r.tree, [adopted], r.env);
  expect(ids).toHaveLength(1);
  await validateCandidateAttribution(r.tree, r.base, adopted, policy, r.env, undefined, ids);
  await r.run(["checkout", "-q", "main"]);
  const newer = await r.commit("newer.txt", "Main moved");
  await r.run(["update-ref", "refs/paws/upstream-main", newer]);
  await r.run(["checkout", "-q", "paws/item"]);
  await r.run(["rebase", "-q", "main"], bot);
  const rebased = (await r.run(["rev-parse", "HEAD"])).trim();
  expect(rebased).not.toBe(adopted);
  await validateCandidateAttribution(r.tree, newer, rebased, policy, r.env, undefined, ids);
  const after = await r.commit("after.txt", "Agent work with the wrong author");
  await expect(
    validateCandidateAttribution(r.tree, newer, after, policy, r.env, undefined, ids),
  ).rejects.toThrow("attribution rejected");
});

test("adopted patch-ids don't cover a person's other commit or a merge commit", async () => {
  const r = await repository();
  await r.run(["update-ref", "refs/paws/upstream-main", r.main]);
  const adopted = await r.commit("person.txt", "A person's commit Paws adopted");
  const ids = await commitPatchIds(r.tree, [adopted], r.env);
  const other = await r.commit("other.txt", "A person's commit Paws never adopted");
  await expect(
    validateCandidateAttribution(r.tree, r.base, other, policy, r.env, undefined, ids),
  ).rejects.toThrow("attribution rejected");
  await r.run(["checkout", "-q", "-b", "side", adopted]);
  await r.commit("side.txt", "Side work", bot);
  await r.run(["checkout", "-q", "paws/item"]);
  await r.run(["reset", "-q", "--hard", adopted]);
  await r.run(["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
  const merge = (await r.run(["rev-parse", "HEAD"])).trim();
  expect(await commitPatchIds(r.tree, [merge], r.env)).toEqual([]);
  await expect(
    validateCandidateAttribution(r.tree, r.base, merge, policy, r.env, undefined, ids),
  ).rejects.toThrow("attribution rejected");
});
