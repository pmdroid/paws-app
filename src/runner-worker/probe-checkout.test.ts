import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git as runGit } from "../acp";
import { checkoutProbeWorktree, probeOutcome, verifyProbeCheckout } from "./probe-checkout";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const env = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};
const git = (args: string[]) => runGit(args, { env });
const path = ".agents/probes/no-raw-sql.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-probe-checkout-"));
  roots.push(root);
  const source = join(root, "source");
  await git(["init", "-q", "--initial-branch=main", source]);
  writeFileSync(join(source, "README.md"), "fixture\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-q", "-m", "first"]);
  const bundle = join(root, "probe.bundle");
  await git(["-C", source, "bundle", "create", "-q", bundle, "refs/heads/main"]);
  const worktree = join(root, "worktree");
  const fetched = await checkoutProbeWorktree(bundle, worktree, git);
  return { source, worktree, fetched };
}

const written = (worktree: string, text = "export {};\n") => {
  mkdirSync(join(worktree, ".agents", "probes"), { recursive: true });
  writeFileSync(join(worktree, path), text);
};

test("a probe checkout is a clean git worktree at the fetched origin/main", async () => {
  const { source, worktree, fetched } = await fixture();
  expect(fetched).toBe((await git(["-C", source, "rev-parse", "main"])).trim());
  expect((await git(["-C", worktree, "rev-parse", "HEAD"])).trim()).toBe(fetched);
  expect((await git(["-C", worktree, "remote"])).trim()).toBe("");
});

test("a probe checkout whose HEAD differs from origin/main is refused", async () => {
  const { worktree, fetched } = await fixture();
  writeFileSync(join(worktree, "README.md"), "moved\n");
  await git(["-C", worktree, "commit", "-q", "-am", "moved"]);
  await expect(verifyProbeCheckout(worktree, fetched, git)).rejects.toThrow(
    "The probe checkout's HEAD is not the fetched origin/main",
  );
  await expect(
    probeOutcome({ worktree, fetched, path, text: '{"failOn":"P1"}', git }),
  ).rejects.toThrow("The probe turn moved HEAD off origin/main");
});

test("a probe checkout with local changes is refused before the turn", async () => {
  const { worktree, fetched } = await fixture();
  writeFileSync(join(worktree, "README.md"), "changed\n");
  await expect(verifyProbeCheckout(worktree, fetched, git)).rejects.toThrow(
    "The probe checkout is not clean",
  );
});

test("a probe turn returns its probe file and a rules entry checked against the entry schema", async () => {
  const { worktree, fetched } = await fixture();
  written(worktree);
  const text =
    'Done.\n```json\n{"paths":["src/db/**"],"failOn":"P1","onFail":"fix","extra":1}\n```';
  expect(await probeOutcome({ worktree, fetched, path, text, git })).toEqual({
    path,
    content: Buffer.from("export {};\n").toString("base64"),
    entry: { paths: ["src/db/**"], failOn: "P1", onFail: "fix" },
  });
});

test("an invalid rules entry is refused", async () => {
  const { worktree, fetched } = await fixture();
  written(worktree);
  for (const text of [
    '{"failOn":"P9"}',
    '{"paths":[],"failOn":"P1"}',
    "no entry",
    '{"onFail":"fix"}',
  ])
    await expect(probeOutcome({ worktree, fetched, path, text, git })).rejects.toThrow(
      "The probe turn proposed no valid rules entry",
    );
});

test("a probe turn that changed another file or wrote no probe is refused", async () => {
  const { worktree, fetched } = await fixture();
  const text = '{"failOn":"P1"}';
  await expect(probeOutcome({ worktree, fetched, path, text, git })).rejects.toThrow();
  written(worktree);
  writeFileSync(join(worktree, ".agents", "probes", "other.ts"), "x");
  await expect(probeOutcome({ worktree, fetched, path, text, git })).rejects.toThrow(
    `The probe turn changed files other than ${path}`,
  );
});
