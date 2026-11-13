import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tempStore } from "./pglite";
import { githubBlobCache } from "../src/db";
import { createGitHubGitReader, type GitHubClient } from "../src/github";
import {
  createGitReader,
  mergeResultPolicyError,
  POLICY_CHANGED_ON_BOTH_SIDES,
  trustedChangedPaths,
  trustedKnownMain,
  trustedMergeResultPolicyError,
  trustedRootFilesAt,
  useGitReader,
} from "../src/closeout-spec/facade";
import { filled, loadCommitPolicy, loadPolicy } from "../src/closeout-spec/policy/load";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  ".agents/closeout.yaml": [
    'specVersion: "0.1"',
    "items:",
    "  - id: test",
    "    kind: command",
    "    gate: beforePR",
    '    exec: ["bun", "test"]',
    "    timeoutSeconds: 60",
    "  - id: review",
    "    kind: review",
    "    gate: beforePR",
    "    skill: .agents/skills/review/SKILL.md",
    "    independence:",
    "      differentSession: true",
    "      differentModel: false",
    "    failOn: P1",
    "    scope: diff",
    "",
  ].join("\n"),
  ".agents/skills/review/SKILL.md": "# Review\n\nRead the diff.\n",
  ".agents/skills/review/notes.md": "Notes.\n",
  "AGENTS.md": "# Acme\n",
  "src/app.ts": "export {};\n",
};

function fixture(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-github-reader-"));
  temps.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  for (const [path, contents] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), contents);
  }
  git(work, "add", ".");
  git(work, "-c", "user.name=Acme", "-c", "user.email=acme@example.com", "commit", "-qm", "policy");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  const head = git(work, "rev-parse", "HEAD").trim();
  const calls: string[] = [];
  const client: GitHubClient = {
    async request({ path }) {
      calls.push(path);
      const route = path.replace("/repos/acme/app", "");
      if (route === "/git/ref/heads/main")
        return { status: 200, body: { object: { sha: head, type: "commit" } } };
      const tree = /^\/git\/trees\/([0-9a-f]+)\?recursive=1$/.exec(route);
      if (tree)
        return {
          status: 200,
          body: {
            truncated: false,
            tree: git(work, "ls-tree", "-r", "-t", "-z", tree[1]!)
              .split("\0")
              .filter(Boolean)
              .map((line) => {
                const [meta, entry] = line.split("\t");
                const [mode, type, sha] = meta!.split(" ");
                return { mode, type, sha, path: entry };
              }),
          },
        };
      const compare = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)/.exec(route);
      if (compare) {
        const base = git(work, "merge-base", compare[1]!, compare[2]!).trim();
        const fields = git(work, "diff", "-M", "--name-status", "-z", base, compare[2]!)
          .split("\0")
          .filter(Boolean);
        const files: { filename: string; previous_filename?: string }[] = [];
        for (let index = 0; index < fields.length;) {
          const status = fields[index++]!;
          if (status.startsWith("R"))
            files.push({ previous_filename: fields[index++]!, filename: fields[index++]! });
          else files.push({ filename: fields[index++]! });
        }
        return {
          status: 200,
          body: { merge_base_commit: { sha: base }, files: files.slice(0, 300) },
        };
      }
      const blob = /^\/git\/blobs\/([0-9a-f]+)$/.exec(route);
      if (blob)
        return {
          status: 200,
          body: {
            encoding: "base64",
            content: execFileSync("git", ["-C", work, "cat-file", "blob", blob[1]!]).toString(
              "base64",
            ),
          },
        };
      return { status: 404, body: { message: "Not Found" } };
    },
  };
  return { work, head, calls, client, home: join(root, "home") };
}

const MIRROR = "/paws/repos/acme/app.git";

function apiReader(
  client: GitHubClient,
  blobs?: Parameters<typeof createGitHubGitReader>[0]["blobs"],
) {
  return createGitHubGitReader({
    locate: (repo) =>
      repo === MIRROR
        ? {
            client,
            owner: "acme",
            repo: "app",
            tokenProvider: { mode: "app" as const, tokenFor: async () => "t" },
          }
        : null,
    ...(blobs ? { blobs } : {}),
  });
}

test("the GitHub reader loads the same policy as the mirror reader at the same commit", async () => {
  const { work, head, calls, client, home } = fixture();
  const fromMirror = await loadPolicy({ repo: work, git: createGitReader(), home });
  const git = apiReader(client);
  const fromApi = await loadPolicy({ repo: MIRROR, git, home });
  expect(fromMirror.ok).toBe(true);
  expect(fromApi).toEqual(fromMirror);
  expect(git.mainCommit(MIRROR)).toBe(head);
  expect(calls.filter((path) => path.includes("/git/trees/"))).toHaveLength(1);

  calls.length = 0;
  expect(loadCommitPolicy({ repo: MIRROR, git }, head)).toEqual(
    loadCommitPolicy({ repo: work, git: createGitReader() }, head),
  );
  expect(calls).toEqual([]);
  expect(await loadPolicy({ repo: MIRROR, git, home })).toEqual(fromMirror);
  expect(calls).toEqual(["/repos/acme/app/git/ref/heads/main"]);
});

test("policy blobs read from GitHub are kept in the database for the next reader", async () => {
  const { calls, client, home } = fixture();
  const store = await tempStore();
  try {
    const blobs = githubBlobCache(store.db);
    const first = await loadPolicy({ repo: MIRROR, git: apiReader(client, blobs), home });
    expect(first.ok).toBe(true);
    expect(calls.filter((path) => path.includes("/git/blobs/"))).toHaveLength(3);
    calls.length = 0;
    expect(await loadPolicy({ repo: MIRROR, git: apiReader(client, blobs), home })).toEqual(first);
    expect(calls.filter((path) => path.includes("/git/blobs/"))).toEqual([]);
  } finally {
    await store.close();
  }
});

test("a repository the GitHub reader cannot locate reports origin/main as unavailable", async () => {
  const { client, home } = fixture();
  const loaded = await loadPolicy({ repo: "/elsewhere", git: apiReader(client), home });
  expect(loaded).toMatchObject({ ok: false, source: "repo" });
});

test("a cold reader loads a review skill directory with many files", async () => {
  const extra = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `.agents/skills/review/ref-${index}.md`,
      `${index}\n`,
    ]),
  );
  const { work, client, home } = fixture(extra);
  const fromMirror = await loadPolicy({ repo: work, git: createGitReader(), home });
  expect(fromMirror.ok).toBe(true);
  expect(await loadPolicy({ repo: MIRROR, git: apiReader(client), home })).toEqual(fromMirror);
});

test("facade reads at a commit hydrate a cold reader", async () => {
  const { work, head, client } = fixture();
  useGitReader(apiReader(client));
  try {
    expect(await trustedKnownMain(MIRROR)).toEqual({ ok: true, commit: head });
    const root = await trustedRootFilesAt(MIRROR, head, ["AGENTS.md", "mise.toml"]);
    expect(root.ok && [...root.files.keys()]).toEqual(["AGENTS.md"]);
  } finally {
    useGitReader(null);
  }
  const git = apiReader(client);
  const input = { repo: MIRROR, git };
  expect(await filled(input, () => loadCommitPolicy(input, head))).toEqual(
    loadCommitPolicy({ repo: work, git: createGitReader() }, head),
  );
});

function sides(main: Record<string, string>, candidate: Record<string, string>) {
  const fixed = fixture();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fixed.work, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  const commit = (branch: string, files: Record<string, string>) => {
    git("checkout", "-q", "-B", branch, fixed.head);
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(fixed.work, path)), { recursive: true });
      writeFileSync(join(fixed.work, path), contents);
    }
    git("add", ".");
    git("-c", "user.name=Acme", "-c", "user.email=acme@example.com", "commit", "-qm", branch);
    return git("rev-parse", "HEAD");
  };
  return { ...fixed, main: commit("next-main", main), candidate: commit("candidate", candidate) };
}

async function viaApi(client: GitHubClient, main: string, head: string) {
  useGitReader(apiReader(client));
  try {
    return await trustedMergeResultPolicyError(MIRROR, main, head);
  } finally {
    useGitReader(null);
  }
}

const BROKEN = 'specVersion: "0.1"\nitems:\n  - id: test\n    kind: command\n';

test("with mirrors off, a policy file changed only on the candidate is read at the candidate head", async () => {
  const { work, client, main, candidate } = sides(
    { "src/app.ts": "export const main = 1;\n" },
    { ".agents/closeout.yaml": BROKEN },
  );
  const error = await viaApi(client, main, candidate);
  expect(error).toContain(".agents/closeout.yaml");
  expect(error).toBe(mergeResultPolicyError(work, main, candidate));
  expect(error?.startsWith(POLICY_CHANGED_ON_BOTH_SIDES)).toBe(false);
});

test("with mirrors off, a policy file changed only on main is read at main", async () => {
  const { work, calls, client, main, candidate } = sides(
    { ".agents/skills/review/notes.md": "Main notes.\n" },
    { "src/app.ts": "export const candidate = 1;\n" },
  );
  expect(await viaApi(client, main, candidate)).toBeUndefined();
  expect(mergeResultPolicyError(work, main, candidate)).toBeUndefined();
  const notes = execFileSync("git", [
    "-C",
    work,
    "rev-parse",
    `${main}:.agents/skills/review/notes.md`,
  ])
    .toString()
    .trim();
  expect(calls).toContain(`/repos/acme/app/git/blobs/${notes}`);
});

test("with mirrors off, a policy file changed on both sides sends the item back", async () => {
  const { client, main, candidate } = sides(
    { ".agents/skills/review/notes.md": "Main notes.\n" },
    { ".agents/skills/review/notes.md": "Candidate notes.\n" },
  );
  expect(await viaApi(client, main, candidate)).toBe(
    `${POLICY_CHANGED_ON_BOTH_SIDES}: .agents/skills/review/notes.md`,
  );
});

async function changedViaApi(client: GitHubClient, base: string, head: string) {
  useGitReader(apiReader(client));
  try {
    return await trustedChangedPaths(MIRROR, base, head);
  } finally {
    useGitReader(null);
  }
}

test("with mirrors off, changed paths come from GitHub's compare and count a rename as both paths", async () => {
  const { work, calls, client, head, candidate } = sides(
    { "AGENTS.md": "# Main\n" },
    { "src/app.ts": "export const candidate = 1;\n", "docs/new.md": "New.\n" },
  );
  execFileSync("git", ["-C", work, "mv", "src/app.ts", "src/main.ts"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.name=Acme",
    "-c",
    "user.email=acme@example.com",
    "commit",
    "-qm",
    "rename",
  ]);
  const renamed = execFileSync("git", ["-C", work, "rev-parse", "HEAD"]).toString().trim();
  calls.length = 0;
  expect(await changedViaApi(client, head, renamed)).toEqual({
    ok: true,
    paths: ["docs/new.md", "src/app.ts", "src/main.ts"],
  });
  expect(calls).toEqual([`/repos/acme/app/compare/${head}...${renamed}?per_page=1`]);
  expect(await trustedChangedPaths(work, head, renamed)).toEqual({
    ok: true,
    paths: ["docs/new.md", "src/app.ts", "src/main.ts"],
  });
  expect(await changedViaApi(client, head, candidate)).toEqual({
    ok: true,
    paths: ["docs/new.md", "src/app.ts"],
  });
});

test("with mirrors off, a compare GitHub cuts off at 300 files is read from the two trees", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 320 }, (_, index) => [`gen/${String(index).padStart(3, "0")}.txt`, "x\n"]),
  );
  const { calls, client, head, candidate } = sides({ "AGENTS.md": "# Main\n" }, many);
  calls.length = 0;
  const read = await changedViaApi(client, head, candidate);
  expect(read).toEqual({ ok: true, paths: Object.keys(many).sort() });
  expect(calls.filter((path) => path.includes("/git/trees/"))).toHaveLength(2);
});

test("with mirrors off, a failed compare leaves the changed paths unavailable", async () => {
  const { client, head } = fixture();
  const read = await changedViaApi(client, head, "f".repeat(40));
  expect(read).toMatchObject({ ok: false });
  expect(!read.ok && read.message).toStartWith("changed paths are unavailable");
});

test("a repository the GitHub reader does not locate keeps its local git diff", async () => {
  const { work, calls, client, head, candidate } = sides(
    { "AGENTS.md": "# Main\n" },
    { "src/app.ts": "local\n" },
  );
  calls.length = 0;
  useGitReader(apiReader(client));
  try {
    expect(await trustedChangedPaths(work, head, candidate)).toEqual({
      ok: true,
      paths: ["src/app.ts"],
    });
  } finally {
    useGitReader(null);
  }
  expect(calls).toEqual([]);
});
