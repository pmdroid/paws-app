import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const inputs = await candidatePolicyInputs(repo, home, undefined, exclusions);
  expect(inputs?.digest).toBe(accepted.policy.digest!);
  const plain = trustedPolicyFiles(repo, home);
  if (!plain.ok || plain.absent) throw new Error("policy missing");
  expect(inputs?.digest).not.toBe(plain.digest);
  expect(inputs?.paths).toContain("review/extra.yaml");
});

test("local policy paths inside the repository include their policy-root prefix", async () => {
  const { repo, home } = fixture();
  const local = join(repo, "rules");
  policy(local);
  expect((await candidatePolicyInputs(repo, home, local))?.paths).toEqual([
    "rules/.agents/closeout.yaml",
    "rules/review/extra.yaml",
  ]);
});

test("external home policies do not confuse home-relative keys with repository paths", async () => {
  const { repo, home } = fixture(false);
  policy(home);
  expect((await candidatePolicyInputs(repo, home))?.paths).toEqual([]);
});

test("a home policy that references inputs inside the repository maps those inputs back to the diff", async () => {
  const { repo, root } = fixture(false);
  write(
    root,
    ".agents/closeout.yaml",
    'specVersion: "0.1"\nimports:\n  - path: repo/review/extra.yaml\n    as: extra\nitems: []\n',
  );
  write(repo, "review/extra.yaml", 'specVersion: "0.1"\nitems: []\n');
  expect((await candidatePolicyInputs(repo, root))?.paths).toEqual(["review/extra.yaml"]);
});

test("a slow origin policy read leaves the event loop available", async () => {
  const { repo, home, root } = fixture();
  const upload = join(root, "slow-upload-pack");
  writeFileSync(upload, '#!/bin/sh\nsleep 0.3\nexec git-upload-pack "$@"\n');
  chmodSync(upload, 0o700);
  execFileSync("git", ["-C", repo, "config", "remote.origin.uploadpack", upload]);
  let finished = false;
  const pending = candidatePolicyInputs(repo, home).finally(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  expect((await pending)?.paths).toContain(".agents/closeout.yaml");
});

test("status policy reads need no remote and do not write FETCH_HEAD", async () => {
  const { repo, home, root } = fixture();
  const flag = join(root, "remote-called");
  const upload = join(root, "unavailable-upload-pack");
  writeFileSync(upload, `#!/bin/sh\ntouch '${flag}'\nexit 1\n`);
  chmodSync(upload, 0o700);
  execFileSync("git", ["-C", repo, "config", "remote.origin.uploadpack", upload]);
  const fetchHead = join(repo, ".git/FETCH_HEAD");
  const before = existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null;
  expect((await candidatePolicyInputs(repo, home, undefined, [], true))?.paths).toContain(
    ".agents/closeout.yaml",
  );
  expect(existsSync(flag)).toBe(false);
  expect(existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null).toBe(before);
  await expect(candidatePolicyInputs(repo, home)).rejects.toMatchObject({
    name: "PolicyFetchError",
  });
  expect(existsSync(flag)).toBe(true);
});

test("trusted policy transport retains credential-helper environment", async () => {
  const { repo, home, root } = fixture();
  const upload = join(root, "authenticated-upload-pack");
  writeFileSync(
    upload,
    '#!/bin/sh\ntest "$PAWS_TEST_TOKEN" = fixture-token || exit 1\nexec git-upload-pack "$@"\n',
  );
  chmodSync(upload, 0o700);
  execFileSync("git", ["-C", repo, "config", "remote.origin.uploadpack", upload]);
  const previous = process.env.PAWS_TEST_TOKEN;
  process.env.PAWS_TEST_TOKEN = "fixture-token";
  try {
    expect((await candidatePolicyInputs(repo, home))?.paths).toContain(".agents/closeout.yaml");
  } finally {
    if (previous === undefined) delete process.env.PAWS_TEST_TOKEN;
    else process.env.PAWS_TEST_TOKEN = previous;
  }
});
