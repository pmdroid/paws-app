import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ArtifactRejectedError, runAgent } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import { insertQueuedItem, listEvidence, listOutbox, migrate, openDatabase } from "../src/db";
import { createEvidenceStore, EvidenceRejectedError } from "../src/evidence";
import { createLinearFileTransfer } from "../src/linear";
import { createEvidenceArtifactPublisher, createLinearArtifactPublisher } from "../src/loop";
import { tempHome } from "./helpers";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const WEBM = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sized(head: Buffer, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes, 1);
  head.copy(buffer);
  return buffer;
}

function setup() {
  const home = tempHome();
  homes.push(home);
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  git(workspace, ["config", "user.name", "Test"]);
  mkdirSync(join(workspace, ".agents"));
  writeFileSync(
    join(workspace, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: browser-proof",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["false"]',
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "init"]);
  git(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).stdout.trim();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  const linearUploads: string[] = [];
  const files = createLinearFileTransfer({
    client: {
      async query(_query, variables) {
        linearUploads.push(String((variables as { filename?: string }).filename));
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload?signature=private",
              assetUrl: "https://uploads.linear.app/workspace/result",
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "host-only-token";
      },
    },
    fetch: async (_url, request) =>
      new Response(null, { status: request?.method === "PUT" ? 200 : 404 }),
  });
  const store = createEvidenceStore({ db, root: join(home, "evidence") });
  let sequence = 0;
  return {
    db,
    head,
    workspace,
    linearUploads,
    write(path: string, bytes: Buffer | string) {
      writeFileSync(join(workspace, path), bytes);
    },
    async run(steps: FakeScript["steps"]) {
      const script = join(home, `script-${++sequence}.json`);
      const trace = join(home, `trace-${sequence}.json`);
      writeFileSync(script, JSON.stringify({ steps: [...steps, { type: "end" }] }));
      await runAgent({
        role: "implementer",
        itemId: "item",
        runId: `run-${sequence}`,
        prompt: "Record the browser proof.",
        worktreePath: workspace,
        pawsRoot: home,
        home,
        checkpoint: false,
        command: process.execPath,
        args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        publishArtifact: createEvidenceArtifactPublisher({
          db,
          evidence: {
            save: (input) =>
              store.save(input).catch((error: unknown) => {
                if (error instanceof EvidenceRejectedError)
                  throw new ArtifactRejectedError(error.message);
                throw error;
              }),
          },
          publicUrl: "https://paws.example/",
          itemId: "item",
          sessionId: "session",
          linear: createLinearArtifactPublisher({
            db,
            files,
            secretsDir: join(home, "secrets"),
            itemId: "item",
            issueId: "issue",
            sessionId: "session",
          }),
        }),
      });
      const recorded = JSON.parse(readFileSync(trace, "utf8")) as {
        artifact: { ok: boolean; text?: string; error?: string };
      };
      return recorded.artifact;
    },
  };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test("a video with a check id lands in the evidence store and Linear gets the Paws link", async () => {
  const f = setup();
  try {
    f.write("proof.webm", sized(WEBM, 15 * 1024 * 1024));
    const artifact = await f.run([
      { type: "run_closeout", id: "browser-proof" },
      { type: "publish_artifact", path: "proof.webm", checkId: "browser-proof" },
    ]);
    expect(artifact.ok).toBe(true);
    const [evidence, ...rest] = listEvidence(f.db, "item");
    expect(rest).toHaveLength(0);
    expect(evidence).toMatchObject({
      runId: "run-1",
      checkId: "browser-proof",
      attempt: 2,
      headCommit: f.head,
      mediaType: "video/webm",
      displayName: "proof.webm",
      sizeBytes: 15 * 1024 * 1024,
    });
    const link = `https://paws.example/evidence/${evidence!.id}`;
    expect(artifact.text).toBe(`[proof.webm](<${link}>)`);
    const activity = listOutbox(f.db, "session").find((row) => row.op === "activity");
    expect(activity?.payload).toMatchObject({
      sessionId: "session",
      kind: "thought",
      body: `Closeout evidence for check \`browser-proof\`: [proof.webm](<${link}>)`,
    });
    expect(f.linearUploads).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("a screenshot with a check id is evidence for the first attempt", async () => {
  const f = setup();
  try {
    f.write("shot.png", sized(PNG, 64));
    const artifact = await f.run([
      { type: "publish_artifact", path: "shot.png", checkId: "browser-proof" },
    ]);
    expect(artifact.ok).toBe(true);
    expect(listEvidence(f.db, "item")[0]).toMatchObject({ attempt: 1, mediaType: "image/png" });
    expect(artifact.text?.startsWith("[shot.png](<https://paws.example/evidence/")).toBe(true);
    expect(f.linearUploads).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("artifacts without a check id and other file types still upload to Linear", async () => {
  const f = setup();
  try {
    f.write("shot.png", sized(PNG, 64));
    f.write("notes.txt", "notes");
    expect((await f.run([{ type: "publish_artifact", path: "shot.png" }])).ok).toBe(true);
    expect(
      (await f.run([{ type: "publish_artifact", path: "notes.txt", checkId: "browser-proof" }])).ok,
    ).toBe(true);
    expect(f.linearUploads).toEqual(["shot.png", "notes.txt"]);
    expect(listEvidence(f.db, "item")).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("the 10 MB cap still applies without a check id", async () => {
  const f = setup();
  try {
    f.write("big.png", sized(PNG, 11 * 1024 * 1024));
    const artifact = await f.run([{ type: "publish_artifact", path: "big.png" }]);
    expect(artifact.ok).toBe(false);
    expect(artifact.error).toContain(`artifact exceeds ${10 * 1024 * 1024} bytes`);
    expect(f.linearUploads).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("a screenshot over the evidence cap is refused and the agent gets the error", async () => {
  const f = setup();
  try {
    f.write("huge.png", sized(PNG, 20 * 1024 * 1024 + 1));
    const artifact = await f.run([
      { type: "publish_artifact", path: "huge.png", checkId: "browser-proof" },
    ]);
    expect(artifact.ok).toBe(false);
    expect(artifact.error).toContain(`artifact exceeds ${20 * 1024 * 1024} bytes`);
    expect(listEvidence(f.db, "item")).toHaveLength(0);
    expect(f.linearUploads).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("evidence store refusals and unknown checks reach the agent", async () => {
  const f = setup();
  try {
    f.write("fake.webm", "not a video");
    const wrongType = await f.run([
      { type: "publish_artifact", path: "fake.webm", checkId: "browser-proof" },
    ]);
    expect(wrongType.ok).toBe(false);
    expect(wrongType.error).toContain("Only WebM and MP4 videos");
    f.write("shot.png", sized(PNG, 64));
    const unknown = await f.run([
      { type: "publish_artifact", path: "shot.png", checkId: "no-such-check" },
    ]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("Closeout check no-such-check is not required");
    expect(listEvidence(f.db, "item")).toHaveLength(0);
    expect(f.linearUploads).toHaveLength(0);
  } finally {
    f.db.close();
  }
});
