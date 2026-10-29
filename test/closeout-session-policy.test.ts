import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import {
  createCloseoutSession,
  decodePolicyFiles,
  encodePolicyFiles,
  encodePolicyChunk,
  trustedPolicyFiles,
  workspacePolicyFiles,
  type PolicyFilesLoad,
} from "../src/closeout-spec";
import { remoteCloseoutPolicy } from "../src/runner-worker";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Report = { required: { id: string }[]; pending: string[]; blocked: string | null };

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function policy(id: string): string {
  return [
    'specVersion: "0.1"',
    "items:",
    `  - id: ${id}`,
    "    kind: command",
    "    gate: beforePR",
    '    exec: ["true"]',
    "    timeoutSeconds: 30",
    "",
  ].join("\n");
}

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-session-policy-"));
  roots.push(root);
  return root;
}

function workspace(policyText: string): string {
  const root = directory();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "closeout.yaml"), policyText);
  writeFileSync(join(root, "README.md"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(root, "README.md"), "changed\n");
  return root;
}

function trusted(id: string): PolicyFilesLoad {
  const root = directory();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "closeout.yaml"), policy(id));
  return workspacePolicyFiles(root);
}

async function report(session: ReturnType<typeof createCloseoutSession>): Promise<Report> {
  return JSON.parse(await session.report()) as Report;
}

test("get_closeout uses the trusted policy and ignores the policy in the workspace", async () => {
  const root = workspace(policy("edited-on-branch"));
  const session = createCloseoutSession(root, { policy: async () => trusted("lint") });
  const listed = await report(session);
  expect(listed.required.map((item) => item.id)).toEqual(["lint"]);
  expect(listed.pending).toEqual(["lint"]);
});

test("a policy change between two get_closeout calls is picked up", async () => {
  const root = workspace(policy("edited-on-branch"));
  const versions = [trusted("lint"), trusted("typecheck")];
  let call = 0;
  const session = createCloseoutSession(root, {
    policy: async () => versions[Math.min(call++, versions.length - 1)]!,
  });
  expect((await report(session)).required.map((item) => item.id)).toEqual(["lint"]);
  expect((await report(session)).required.map((item) => item.id)).toEqual(["typecheck"]);
});

test("a policy Paws cannot provide blocks with its reason", async () => {
  const root = workspace(policy("edited-on-branch"));
  const session = createCloseoutSession(root, {
    policy: async () => ({ ok: false, message: "Paws could not provide the Closeout policy" }),
  });
  expect((await report(session)).blocked).toContain("Paws could not provide the Closeout policy");
  expect(await session.run("edited-on-branch")).toContain(
    "Paws could not provide the Closeout policy",
  );
});

test("policy files that do not match their digest block", async () => {
  const root = workspace(policy("edited-on-branch"));
  const loaded = trusted("lint");
  if (!loaded.ok || loaded.absent) throw new Error("fixture policy is missing");
  const session = createCloseoutSession(root, {
    policy: async () => ({ ...loaded, digest: `sha256:${"0".repeat(64)}` }),
  });
  expect((await report(session)).blocked).toContain("digest");
});

test("the trusted policy comes from origin/main, not from the worktree", async () => {
  const origin = directory();
  git(origin, "init", "-q", "--bare", "-b", "main");
  const seed = workspace(policy("lint"));
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "HEAD:main");
  const clone = directory();
  git(clone, "clone", "-q", origin, ".");
  writeFileSync(join(clone, ".agents", "closeout.yaml"), policy("edited-on-branch"));
  const first = trustedPolicyFiles(clone);
  expect(first.ok && !first.absent && first.digest).toBe(
    (trusted("lint") as { digest: string }).digest,
  );
  writeFileSync(join(seed, ".agents", "closeout.yaml"), policy("typecheck"));
  git(seed, "commit", "-q", "-am", "change policy");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const second = trustedPolicyFiles(clone);
  expect(second.ok && !second.absent && second.digest).toBe(
    (trusted("typecheck") as { digest: string }).digest,
  );
});

test("policy files round trip through the runner answer and bad answers block", () => {
  const loaded = trusted("lint");
  const decoded = decodePolicyFiles(encodePolicyFiles(loaded));
  expect(decoded).toEqual(loaded);
  expect(decodePolicyFiles(encodePolicyFiles({ ok: true, absent: true }))).toEqual({
    ok: true,
    absent: true,
  });
  expect(decodePolicyFiles(encodePolicyFiles({ ok: false, message: "fetch failed" }))).toEqual({
    ok: false,
    message: "fetch failed",
  });
  expect(decodePolicyFiles("not json")).toMatchObject({ ok: false });
});

test("a remote session asks Paws for the policy through the runner channel", async () => {
  const emitted: unknown[] = [];
  const loaded = trusted("lint");
  const load = remoteCloseoutPolicy(
    (event) => emitted.push(event),
    async (requestId) => {
      expect(emitted).toEqual([{ type: "closeout_policy", requestId, offset: 0 }]);
      return { answer: encodePolicyFiles(loaded) };
    },
    new AbortController().signal,
  );
  expect(await load()).toEqual(loaded);
  const failing = remoteCloseoutPolicy(
    () => {},
    async () => {
      throw new Error("channel closed");
    },
    new AbortController().signal,
  );
  expect(await failing()).toMatchObject({
    ok: false,
    message: expect.stringContaining("Paws could not provide the Closeout policy"),
  });
});

test("large policies are transferred in bounded chunks and policy changes fail closed", async () => {
  const loaded = trusted("lint");
  if (!loaded.ok || loaded.absent) throw new Error("expected policy");
  const large = {
    ...loaded,
    files: new Map([...loaded.files, ["extra", new Uint8Array(100_000).fill(65)]]),
  };
  let request: { offset?: number; hash?: string } = {};
  let count = 0;
  const load = remoteCloseoutPolicy(
    (event) => {
      request = event;
      count++;
    },
    async () => ({ answer: encodePolicyChunk(large, request.offset!, request.hash) }),
    new AbortController().signal,
  );
  expect(await load()).toEqual(large);
  expect(count).toBeGreaterThan(1);
  let changed = false;
  const unstable = remoteCloseoutPolicy(
    (event) => {
      request = event;
    },
    async () => {
      const response = encodePolicyChunk(changed ? loaded : large, request.offset!, request.hash);
      changed = true;
      return { answer: response };
    },
    new AbortController().signal,
  );
  expect(await unstable()).toMatchObject({
    ok: false,
    message: "Closeout policy changed during transfer",
  });
});
