import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { assertDescendsFromAny, candidateBases, CHECKPOINT_COMMIT_MESSAGE } from "../src/core";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "paws-checkpoint-bases-"));
  roots.push(root);
  const run = (args: string[]) => git(["-C", root, ...args]);
  await run(["init", "-q", "-b", "main"]);
  const commit = async (text: string, message: string) => {
    writeFileSync(join(root, "work.txt"), text);
    await run(["add", "."]);
    await run(["commit", "-qm", message]);
    return (await run(["rev-parse", "HEAD"])).trim();
  };
  return { run, commit };
}

test("a candidate that replaced the Paws checkpoint it started from builds on the checkpoint's parent", async () => {
  const { run, commit } = await repository();
  const before = await commit("real work", "Real work");
  const checkpoint = await commit(
    "half done",
    `${CHECKPOINT_COMMIT_MESSAGE}\n\nCo-authored-by: A <a@b.c>\n`,
  );
  await run(["reset", "-q", "--hard", before]);
  const candidate = await commit("done", "Finish the work");

  const bases = await candidateBases(run, checkpoint);
  expect(bases).toEqual([checkpoint, before]);
  await assertDescendsFromAny(run, bases, candidate);
});

test("a candidate that dropped an ordinary base commit is still refused", async () => {
  const { run, commit } = await repository();
  const before = await commit("real work", "Real work");
  const base = await commit("more", "More real work");
  await run(["reset", "-q", "--hard", before]);
  const candidate = await commit("other", "Something else");

  const bases = await candidateBases(run, base);
  expect(bases).toEqual([base]);
  expect(assertDescendsFromAny(run, bases, candidate)).rejects.toThrow();
});
