import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateGrowth, candidateSize, narrowBackHandoff, type CandidateSize } from "./narrow-back";

const size = (head: string, lines: number, files = 1): CandidateSize => ({ head, lines, files });

test("a candidate under the limit that did not double is left alone", () => {
  expect(candidateGrowth([size("a", 300), size("b", 500)], 800)).toBeNull();
  expect(candidateGrowth([size("a", 800)], 800)).toBeNull();
  expect(candidateGrowth([size("a", 50), size("b", 120)], 800)).toBeNull();
  expect(candidateGrowth([], 800)).toBeNull();
});

test("past the limit, the last smaller head is the latest round under it", () => {
  const growth = candidateGrowth([size("a", 300), size("b", 700), size("c", 900)], 800);
  expect(growth).toMatchObject({ smaller: size("b", 700), doubled: false, limit: 800 });
  expect(candidateGrowth([size("a", 1052)], 800)).toMatchObject({ smaller: null });
});

test("a candidate that doubles between two rounds narrows back under the limit too", () => {
  const growth = candidateGrowth([size("a", 150), size("b", 320)], 800);
  expect(growth).toMatchObject({ previous: size("a", 150), smaller: size("a", 150), doubled: true });
});

test("a limit of 0 turns the size check off", () => {
  expect(candidateGrowth([size("a", 10), size("b", 5000)], 0)).toBeNull();
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the handoff lists the files and commits added since the last smaller head", async () => {
  const repo = mkdtempSync(join(tmpdir(), "paws-narrow-"));
  roots.push(repo);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
  const commit = (message: string) => {
    run("add", "-A");
    run("-c", "user.name=Acme", "-c", "user.email=acme@example.com", "commit", "-qm", message);
    return run("rev-parse", "HEAD");
  };
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
  run("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "acme\n");
  const base = commit("init");
  writeFileSync(join(repo, "fix.ts"), `${lines(40)}\n`);
  const small = commit("Fix the token refresh");
  writeFileSync(join(repo, "admission.ts"), `${lines(900)}\n`);
  writeFileSync(join(repo, "fix.ts"), `${lines(45)}\n`);
  const grown = commit("Add an admission layer");
  const git = async (args: string[]) =>
    execFileSync("git", args, { stdio: "pipe" }).toString();

  const sizes = [
    await candidateSize(git, repo, base, small),
    await candidateSize(git, repo, base, grown),
  ];
  expect(sizes).toEqual([size(small, 40), size(grown, 945, 2)]);
  const growth = candidateGrowth(sizes, 800)!;
  const handoff = await narrowBackHandoff(git, {
    repo,
    base,
    growth,
    findings: "- review P1 at admission.ts:3: unchecked grant",
  });
  expect(handoff).toContain(
    `Paws stopped the next fix round: the change grew to 945 changed lines in 2 files, past the 800-line limit and double the 40 changed lines at ${small.slice(0, 7)}.`,
  );
  expect(handoff).toContain(`Added since ${small.slice(0, 7)} (40 changed lines in 1 file):`);
  expect(handoff).toContain("Files:\n- admission.ts (+900 −0)\n- fix.ts (+5 −0)\nCommits:\n");
  expect(handoff).toContain(`- ${grown.slice(0, 7)} Add an admission layer`);
  expect(handoff).not.toContain("Fix the token refresh");
  expect(handoff).toEndWith("- review P1 at admission.ts:3: unchecked grant");
});
