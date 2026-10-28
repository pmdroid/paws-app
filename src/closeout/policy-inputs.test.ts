import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { candidatePolicyInputs, trustedPolicyFiles } from "./index";
import { decision } from "../closeout-spec";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const POLICY =
  'specVersion: "0.1"\nimports:\n  - path: review/extra.yaml\n    as: extra\nitems: []\n';
function write(root: string, path: string, content: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
function policy(root: string) {
  write(root, ".agents/closeout.yaml", POLICY);
  write(root, "review/extra.yaml", 'specVersion: "0.1"\nitems: []\n');
}
function fixture(withPolicy = true) {
  const root = mkdtempSync(join(tmpdir(), "paws-policy-inputs-"));
  roots.push(root);
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", "-b", "main", origin);
  git("-C", repo, "init", "-b", "main");
  git("-C", repo, "config", "user.name", "Paws Test");
  git("-C", repo, "config", "user.email", "paws@example.invalid");
  git("-C", repo, "config", "commit.gpgsign", "false");
  write(repo, "file.ts", "export const value = 1;\n");
  if (withPolicy) policy(repo);
  git("-C", repo, "add", ".");
  git("-C", repo, "commit", "-m", "fixture");
  git("-C", repo, "remote", "add", "origin", origin);
  git("-C", repo, "push", "origin", "HEAD:main");
  const head = git("-C", repo, "rev-parse", "HEAD");
  return { root, repo, home, head };
}

test("automatic approval policy inputs match the decision digest with checkout exclusions", async () => {
  const { repo, home, head } = fixture();
  const exclusions = ["private/**"];
  const accepted = await decision({
    repo,
    home,
    base: head,
    head,
    gate: "beforePR",
    checkoutExclusions: exclusions,
  });
  expect(accepted.decision).toBe("accepted");
  const inputs = candidatePolicyInputs(repo, home, undefined, exclusions);
  expect(inputs?.digest).toBe(accepted.policy.digest!);
  const plain = trustedPolicyFiles(repo, home);
  if (!plain.ok || plain.absent) throw new Error("policy missing");
  expect(inputs?.digest).not.toBe(plain.digest);
  expect(inputs?.paths).toContain("review/extra.yaml");
});

test("local policy paths inside the repository include their policy-root prefix", () => {
  const { repo, home } = fixture();
  const local = join(repo, "rules");
  policy(local);
  expect(candidatePolicyInputs(repo, home, local)?.paths).toEqual([
    "rules/.agents/closeout.yaml",
    "rules/review/extra.yaml",
  ]);
});

test("external home policies do not confuse home-relative keys with repository paths", () => {
  const { repo, home } = fixture(false);
  policy(home);
  expect(candidatePolicyInputs(repo, home)?.paths).toEqual([]);
});

test("a home policy that references inputs inside the repository maps those inputs back to the diff", () => {
  const { repo, root } = fixture(false);
  write(
    root,
    ".agents/closeout.yaml",
    'specVersion: "0.1"\nimports:\n  - path: repo/review/extra.yaml\n    as: extra\nitems: []\n',
  );
  write(repo, "review/extra.yaml", 'specVersion: "0.1"\nitems: []\n');
  expect(candidatePolicyInputs(repo, root)?.paths).toEqual(["review/extra.yaml"]);
});
