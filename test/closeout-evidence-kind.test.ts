import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createCloseoutSession,
  run,
  decodePolicyFiles,
  encodePolicyFiles,
  workspacePolicyFiles,
  type PublishedEvidence,
} from "../src/closeout-spec";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VISUAL_PROOF = [
  "  - id: visual-proof",
  "    kind: evidence",
  "    gate: beforePR",
  '    paths: ["src/web/**", "landing/**"]',
  "    hint: Screenshot each changed screen at desktop width and at 390 px.",
];

type Report = {
  required: Array<{ id: string; kind: string; hint: string; status: string }>;
  pending: string[];
};

test("a change outside paths does not require visual proof", async () => {
  const f = fixture(VISUAL_PROOF);
  f.commit("src/core/state.ts", "export {};\n");
  const report = await f.report([]);
  expect(report.required.map((item) => item.id)).toEqual(["lint"]);
  expect(report.pending).toEqual(["lint"]);
  expect(await f.judge([])).toEqual({ decision: "accepted", state: "skipped" });
});

test("a frontend change without evidence is pending, then fails in Paws Closeout", async () => {
  const f = fixture(VISUAL_PROOF);
  f.commit("src/web/page.ts", "export {};\n");
  const report = await f.report([]);
  expect(report.required.find((item) => item.id === "visual-proof")).toMatchObject({
    kind: "evidence",
    status: "missing",
    hint: 'Screenshot each changed screen at desktop width and at 390 px. Call publish_artifact with checkId "visual-proof" for each file.',
  });
  expect(report.pending).toEqual(["lint", "visual-proof"]);
  const ran = await f.session([]).run("visual-proof");
  expect(ran).toContain("runs nothing");
  expect(ran).toContain('publish_artifact with checkId "visual-proof"');
  const judged = await f.judge([]);
  expect(judged).toEqual({ decision: "rejected", state: "failed" });
  expect(f.message).toContain("0 of 1 screenshot or video published.");
  expect(f.message).toContain("Screenshot each changed screen");
});

test("one screenshot from an earlier commit of the same task passes", async () => {
  const f = fixture(VISUAL_PROOF);
  const earlier = f.commit("src/web/page.ts", "export {};\n");
  f.commit("src/web/page.ts", "export const done = true;\n");
  const shot: PublishedEvidence = { checkId: "visual-proof", media: "image", commit: earlier };
  const report = await f.report([shot]);
  expect(report.required.find((item) => item.id === "visual-proof")?.status).toBe("passed");
  expect(report.pending).toEqual(["lint"]);
  expect(await f.judge([shot])).toEqual({ decision: "accepted", state: "passed" });

  const other = { ...shot, commit: f.sideCommit() };
  expect(await f.judge([other])).toEqual({ decision: "rejected", state: "failed" });
  const wrongCheck = { ...shot, checkId: "lint" };
  expect(await f.judge([wrongCheck])).toEqual({ decision: "rejected", state: "failed" });
});

test("a video counts only when media allows it", async () => {
  const videos = fixture([...VISUAL_PROOF, "    media: [video]"]);
  const head = videos.commit("landing/index.html", "<p>hi</p>\n");
  const video: PublishedEvidence = { checkId: "visual-proof", media: "video", commit: head };
  expect(await videos.judge([video])).toEqual({ decision: "accepted", state: "passed" });
  expect(await videos.judge([{ ...video, media: "image" }])).toEqual({
    decision: "rejected",
    state: "failed",
  });
  expect(videos.message).toContain("0 of 1 video published.");

  const either = fixture(VISUAL_PROOF);
  const tip = either.commit("landing/index.html", "<p>hi</p>\n");
  expect(await either.judge([{ ...video, commit: tip }])).toEqual({
    decision: "accepted",
    state: "passed",
  });
});

test("minimum 2 needs two files", async () => {
  const f = fixture([...VISUAL_PROOF, "    minimum: 2"]);
  const head = f.commit("src/web/page.ts", "export {};\n");
  const shot: PublishedEvidence = { checkId: "visual-proof", media: "image", commit: head };
  expect((await f.report([shot])).pending).toContain("visual-proof");
  expect(await f.judge([shot])).toEqual({ decision: "rejected", state: "failed" });
  expect(f.message).toContain("1 of 2 screenshots or videos published.");
  expect(await f.judge([shot, { ...shot, media: "video" }])).toEqual({
    decision: "accepted",
    state: "passed",
  });
});

test("the policy schema rejects unknown media and the runner transfer keeps published files", () => {
  const f = fixture([...VISUAL_PROOF, "    media: [audio]"]);
  const loaded = workspacePolicyFiles(f.root);
  expect(loaded.ok).toBe(false);

  const good = fixture(VISUAL_PROOF);
  const files = workspacePolicyFiles(good.root);
  if (!files.ok || files.absent) throw new Error("policy did not load");
  const published: PublishedEvidence[] = [
    { checkId: "visual-proof", media: "image", commit: "a".repeat(40) },
  ];
  const decoded = decodePolicyFiles(encodePolicyFiles({ ...files, published }));
  expect(decoded).toMatchObject({ ok: true, absent: false, published });
});

function fixture(evidence: string[]) {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-evidence-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  mkdirSync(join(root, ".agents"));
  writeFileSync(
    join(root, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: lint",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["true"]',
      "    timeoutSeconds: 30",
      ...evidence,
      "",
    ].join("\n"),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const base = head(root);
  const f = {
    root,
    message: "",
    commit(path: string, content: string): string {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", `change ${path}`]);
      return head(root);
    },
    /** A commit on another branch, which the candidate does not contain. */
    sideCommit(): string {
      const tip = head(root);
      git(root, ["checkout", "-q", "-b", "side", base]);
      const side = f.commit("src/web/other.ts", "export {};\n");
      git(root, ["checkout", "-q", "main"]);
      expect(head(root)).toBe(tip);
      return side;
    },
    session(published: PublishedEvidence[]) {
      return createCloseoutSession(root, {
        policy: async () => {
          const files = workspacePolicyFiles(root);
          return files.ok && !files.absent ? { ...files, published } : files;
        },
      });
    },
    async report(published: PublishedEvidence[]): Promise<Report> {
      return JSON.parse(await f.session(published).report()) as Report;
    },
    async judge(published: PublishedEvidence[]) {
      const document = await run({
        repo: root,
        base,
        head: head(root),
        gate: "beforePR",
        task: "task",
        candidate: { session: "s", model: "m", provider: "p" },
        policyRoot: root,
        pawsHome: join(root, ".git", "paws"),
        evidenceDir: join(root, ".git", "closeout"),
        published,
      });
      const item = document.items.find((entry) => entry.id === "visual-proof");
      f.message = item?.message ?? "";
      return { decision: document.decision, state: item?.state };
    },
  };
  return f;
}

function head(root: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
