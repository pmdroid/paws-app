import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  beginImplementRun,
  insertQueuedItem,
  migrate,
  openDatabase,
  saveEvidence,
  type EvidenceMediaType,
} from "../db";
import {
  createFakeGitData,
  storeEvidenceFiles,
  type FakeGitData,
  type GitHubClient,
} from "../github";
import { EVIDENCE_INLINE_LIMITS } from "./artifacts";
import { pullRequestScreenshots } from "./pull-screenshots";

const NOW = 1_700_000_000_000;
const HEAD = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "paws-pull-screenshots-"));
  roots.push(root);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-1129", sessionKey: "ses_1", title: "Screens" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  let created = 0;
  const add = (
    displayName: string,
    content: string,
    options: { mediaType?: EvidenceMediaType; sizeBytes?: number; id?: string } = {},
  ) => {
    const id = options.id ?? `ev-${++created}`;
    const bytes = new TextEncoder().encode(content);
    writeFileSync(path.join(root, id), bytes);
    saveEvidence(db, {
      id,
      itemId: item.id,
      runId: run.id,
      checkId: "visual-proof",
      attempt: 1,
      mediaType: options.mediaType ?? "image/png",
      sizeBytes: options.sizeBytes ?? bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      displayName,
      headCommit: HEAD,
      createdAt: NOW + created,
    });
    return createHash("sha256").update(bytes).digest("hex");
  };
  return { db, root, itemId: item.id, add };
}

function publish(
  s: ReturnType<typeof setup>,
  git: FakeGitData,
  journal: string[] = [],
): Promise<string> {
  const client: GitHubClient = {
    request: async (request) => git.respond(request) ?? { status: 404, body: null },
  };
  return pullRequestScreenshots({
    db: s.db,
    itemId: s.itemId,
    root: s.root,
    owner: "acme",
    repo: "monorepo",
    store: (files) =>
      storeEvidenceFiles({
        client,
        owner: "acme",
        repo: "monorepo",
        issue: "ENG-1129",
        files,
        tokenProvider: { mode: "token", tokenFor: async () => "token" },
      }),
    journal: (line) => journal.push(line),
  });
}

test("two images commit once on top of the evidence ref and link in publication order", async () => {
  const s = setup();
  const wide = s.add("Settings 1440px", "wide");
  const narrow = s.add("Settings 390px", "narrow");
  const git = createFakeGitData({ files: ["old.png"] });
  const tip = git.tip!;
  const body = await publish(s, git);
  expect(git.blobs).toHaveLength(2);
  const commit = git.tip!;
  expect(git.commits.get(commit)).toMatchObject({
    parents: [tip],
    message: "Paws evidence for ENG-1129 [skip ci]",
  });
  expect(git.trees.get(git.commits.get(commit)!.tree)).toEqual([
    "old.png",
    `${wide}.png`,
    `${narrow}.png`,
  ]);
  expect(git.refWrites).toEqual([{ method: "PATCH", body: { sha: commit, force: false } }]);
  const base = `https://github.com/acme/monorepo/blob/${commit}`;
  expect(body).toBe(
    [
      "## Screenshots",
      `![Settings 1440px](${base}/${wide}.png?raw=true)`,
      `![Settings 390px](${base}/${narrow}.png?raw=true)`,
    ].join("\n\n"),
  );
});

test("the same images again make no commit and link the commit that holds them", async () => {
  const s = setup();
  const sha = s.add("Settings", "same bytes");
  const git = createFakeGitData();
  await publish(s, git);
  const holder = git.tip!;
  const commits = git.commits.size;
  const body = await publish(s, git);
  expect(git.commits.size).toBe(commits);
  expect(git.refWrites).toHaveLength(1);
  expect(body).toContain(`blob/${holder}/${sha}.png?raw=true`);
});

test("the first publication creates the ref with a parentless commit", async () => {
  const s = setup();
  s.add("Settings", "first");
  const git = createFakeGitData();
  await publish(s, git);
  expect(git.commits.get(git.tip!)!.parents).toEqual([]);
  expect(git.refWrites).toEqual([
    { method: "POST", body: { ref: "refs/paws/evidence", sha: git.tip } },
  ]);
});

test("a moved ref is re-read and retried, and three moves leave the section out", async () => {
  const s = setup();
  s.add("Settings", "raced");
  const git = createFakeGitData({ files: [] });
  git.rejectRefWrites = 1;
  const body = await publish(s, git);
  expect(git.refWrites).toHaveLength(2);
  const tip = git.commits.get(git.tip!)!;
  expect(git.commits.get(tip.parents[0]!)!.message).toBe("another publication");
  expect(body).toContain("## Screenshots");

  const again = setup();
  again.add("Other", "never stored");
  const busy = createFakeGitData({ files: [] });
  busy.rejectRefWrites = 3;
  const journal: string[] = [];
  expect(await publish(again, busy, journal)).toBe("");
  expect(busy.refWrites).toHaveLength(3);
  expect(journal).toHaveLength(1);
  expect(journal[0]).toContain("moved during each of 3 attempts");
});

test("videos, large images and rejected evidence are not uploaded, and only 20 images are", async () => {
  const s = setup();
  s.add("Recording", "video", { mediaType: "video/webm" });
  s.add("Huge", "huge", { sizeBytes: EVIDENCE_INLINE_LIMITS.image + 1 });
  s.add("Rejected", "rejected", { id: "ev-rejected" });
  s.db.run(
    "INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, kind, outcome) VALUES (?,?,?,?,?,?,?)",
    [
      "q-1",
      s.itemId,
      "visual-proof",
      JSON.stringify(["ev-rejected"]),
      NOW,
      "review",
      "changes_requested",
    ],
  );
  for (let index = 0; index < 22; index++) s.add(`Screen ${index}`, `screen ${index}`);
  const git = createFakeGitData();
  const body = await publish(s, git);
  expect(git.blobs).toHaveLength(20);
  expect(body.split("\n\n").slice(1)).toHaveLength(20);
  expect(body).toContain("![Screen 19]");
  expect(body).not.toContain("Screen 20");
  for (const name of ["Recording", "Huge", "Rejected"]) expect(body).not.toContain(name);
});

test("a GitHub error while storing leaves the section out with one journal line", async () => {
  const s = setup();
  s.add("Settings", "error");
  const git = createFakeGitData();
  git.failPath = "trees";
  const journal: string[] = [];
  expect(await publish(s, git, journal)).toBe("");
  expect(journal).toHaveLength(1);
  expect(git.tip).toBeNull();
});

test("an unreadable evidence file leaves the section out", async () => {
  const s = setup();
  s.add("Settings", "gone");
  rmSync(path.join(s.root, "ev-1"));
  const journal: string[] = [];
  expect(await publish(s, createFakeGitData(), journal)).toBe("");
  expect(journal).toHaveLength(1);
});

test("brackets in the display name are escaped", async () => {
  const s = setup();
  s.add("Settings [dark] \\ wide", "brackets");
  const body = await publish(s, createFakeGitData());
  expect(body).toContain("![Settings \\[dark\\] \\\\ wide](");
});
