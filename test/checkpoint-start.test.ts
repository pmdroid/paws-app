import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { CHECKPOINT_COMMIT_MESSAGE, checkpointStart } from "../src/core";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "paws-checkpoint-start-"));
  roots.push(root);
  const run = (args: string[]) => git(["-C", root, ...args]);
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.name", "Agent"]);
  await run(["config", "user.email", "agent@example.com"]);
  const commit = async (text: string, message: string) => {
    writeFileSync(join(root, "work.txt"), text);
    await run(["add", "."]);
    await run(["commit", "-qm", message]);
    return (await run(["rev-parse", "HEAD"])).trim();
  };
  return { run, commit };
}

test("a WIP checkpoint starts at its parent, an agent commit at itself", async () => {
  const { run, commit } = await repository();
  const base = await commit("base", "Base");
  const own = await commit("own", "Add the contract");
  const wip = await commit("half done", CHECKPOINT_COMMIT_MESSAGE);
  expect(await checkpointStart(run, wip, [base])).toBe(own);
  expect(await checkpointStart(run, own, [base])).toBe(own);
});

test("a checkpoint on neither base is refused", async () => {
  const { run, commit } = await repository();
  const root = await commit("root", "Root");
  const base = await commit("base", "Base");
  await run(["reset", "-q", "--hard", root]);
  const wip = await commit("elsewhere", CHECKPOINT_COMMIT_MESSAGE);
  expect(checkpointStart(run, wip, [base])).rejects.toThrow();
  expect(await checkpointStart(run, wip, [base, root])).toBe(root);
});
