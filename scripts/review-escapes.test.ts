import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeoutTrailer,
  draftEscape,
  findCandidates,
  fixKind,
  gitIn,
  isAppAuthor,
  listPulls,
  parseBlame,
  parseGhPulls,
  pullNumberFromSubject,
  readEscapes,
  removedRanges,
  type Options,
} from "./review-escapes";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function options(overrides: Partial<Options> = {}): Options {
  return {
    repo: "pmdroid/paws-app",
    app: "paws-helper",
    days: 30,
    branch: "HEAD",
    source: "git",
    now: new Date(),
    known: new Set(),
    ...overrides,
  };
}

function repoWithEscape(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-escapes-"));
  const git = (args: string[], author = "Pascal Matthiesen") => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  const commit = (file: string, text: string, message: string, author?: string) => {
    writeFileSync(join(dir, file), text);
    git(["add", file]);
    git(["commit", "-q", "-m", message], author);
  };
  git(["init", "-q", "-b", "main"]);
  commit("limit.ts", "export const limit = 10;\n", "Start (#1)");
  commit(
    "limit.ts",
    "export const limit = 10;\nexport function over(n: number) {\n  return n >= limit;\n}\n",
    `Add over() (#2)\n\nCloseout: accepted\nBase: ${BASE}\nHead: ${HEAD}\n`,
    "paws-helper[bot]",
  );
  commit("notes.md", "notes\n", "Docs (#3)", "paws-helper[bot]");
  commit(
    "limit.ts",
    "export const limit = 10;\nexport function over(n: number) {\n  return n > limit;\n}\n",
    "Fix the off-by-one in over() (#4)",
  );
  return dir;
}

test("the fixing pull request names the Paws pull request whose line it changed", () => {
  const git = gitIn(repoWithEscape());
  const opts = options();
  const pulls = listPulls(git, opts);
  expect(pulls.map((pull) => pull.number)).toEqual([4, 3, 2, 1]);

  const candidates = findCandidates(git, pulls, opts);
  expect(candidates).toHaveLength(1);
  const [candidate] = candidates;
  expect(candidate?.original).toMatchObject({ pr: 2, title: "Add over()", base: BASE, head: HEAD });
  expect(candidate?.fix).toMatchObject({ pr: 4, title: "Fix the off-by-one in over()" });
  expect(candidate?.kind).toBe("fix");
  expect(candidate?.lines).toEqual([{ file: "limit.ts", line: 3, content: "return n >= limit;" }]);
  expect(draftEscape(candidate!)).toMatchObject({ id: "2-4", file: "limit.ts", line: 3 });

  expect(findCandidates(git, pulls, options({ known: new Set(["2-4"]) }))).toEqual([]);
  expect(findCandidates(git, pulls, options({ app: "someone-else" }))).toEqual([]);
});

test("pull requests from gh keep their refs and the app login", () => {
  const pulls = parseGhPulls(
    JSON.stringify([
      {
        number: 7,
        title: "T",
        body: null,
        author: { login: "app/paws-helper", is_bot: true },
        mergedAt: "2026-10-20T00:00:00Z",
        mergeCommit: { oid: HEAD },
        baseRefOid: BASE,
        headRefOid: HEAD,
      },
      { number: 8, title: "closed", body: "", author: null, mergedAt: "", mergeCommit: null },
    ]),
  );
  expect(pulls).toEqual([
    {
      number: 7,
      title: "T",
      body: "",
      author: "app/paws-helper",
      mergedAt: "2026-10-20T00:00:00Z",
      mergeCommit: HEAD,
      baseRefOid: BASE,
      headRefOid: HEAD,
    },
  ]);
  expect(isAppAuthor("app/paws-helper", "paws-helper")).toBe(true);
  expect(isAppAuthor("paws-helper[bot]", "paws-helper")).toBe(true);
  expect(isAppAuthor("pmdroid", "paws-helper")).toBe(false);
});

test("subjects, trailers and fix kinds", () => {
  expect(pullNumberFromSubject("PAS-1: Thing (#12)")).toBe(12);
  expect(pullNumberFromSubject("Merge pull request #15 from pmdroid/x")).toBe(15);
  expect(pullNumberFromSubject("local commit")).toBeNull();
  expect(closeoutTrailer(`Closeout: accepted\nBase: ${BASE}\nHead: ${HEAD}\n`)).toEqual({
    base: BASE,
    head: HEAD,
  });
  expect(fixKind({ title: 'Revert "PAS-1"', body: "" })).toBe("revert");
  expect(fixKind({ title: "fix(runner): keep it", body: "" })).toBe("fix");
  expect(fixKind({ title: "Make the flaky tests deterministic", body: "" })).toBe("fix");
  expect(fixKind({ title: "Add a page", body: "Fixes PAS-9" })).toBe("change");
});

test("removed ranges follow the old path and skip pure additions", () => {
  const diff = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -3 +3 @@",
    "@@ -10,2 +9,0 @@",
    "@@ -20,0 +19,4 @@",
    "diff --git a/added.ts b/added.ts",
    "--- /dev/null",
    "+++ b/added.ts",
    "@@ -0,0 +1 @@",
  ].join("\n");
  expect([...removedRanges(diff)]).toEqual([
    [
      "old.ts",
      [
        [3, 1],
        [10, 2],
      ],
    ],
  ]);
});

test("blame lines carry the commit, the original file and the original line", () => {
  const sha = "c".repeat(40);
  const output = [
    `${sha} 7 3 1`,
    "author x",
    "filename src/a.ts",
    "\treturn n >= limit;",
    `${sha} 8 4`,
    "filename src/a.ts",
    "\t}",
    "",
  ].join("\n");
  expect(parseBlame(output)).toEqual([
    { commit: sha, file: "src/a.ts", line: 7, content: "return n >= limit;" },
    { commit: sha, file: "src/a.ts", line: 8, content: "}" },
  ]);
});

const SHA = /^[0-9a-f]{40}$/;

test("each checked-in review escape names both pull requests, the replay commits and the bug", () => {
  const escapes = readEscapes(join(import.meta.dir, "../evals/review-escapes.jsonl"));
  expect(escapes.length).toBeGreaterThanOrEqual(15);
  const ids = new Set<string>();
  for (const escape of escapes) {
    expect(escape.id).toBe(`${escape.original.pr}-${escape.fix.pr}`);
    expect(ids.has(escape.id)).toBe(false);
    ids.add(escape.id);
    expect(escape.fix.pr).toBeGreaterThan(escape.original.pr);
    for (const sha of [
      escape.original.base,
      escape.original.head,
      escape.original.mergeCommit,
      escape.fix.mergeCommit,
    ]) {
      expect(sha).toMatch(SHA);
    }
    expect(escape.original.title).not.toBe("");
    expect(escape.fix.title).not.toBe("");
    expect(escape.file).not.toBe("");
    expect(escape.line).toBeGreaterThan(0);
    expect(escape.bug).toMatch(/^\S[^\n]*\.$/);
    expect(escape.confirmedBy).not.toBe("");
    expect(escape.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(["confirmed", "likely"]).toContain(escape.confidence);
    if (escape.note !== undefined) expect(escape.note).not.toBe("");
  }
});
