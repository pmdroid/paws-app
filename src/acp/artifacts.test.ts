import { connect } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { snapshotArtifactFile } from "./artifacts";
import { startHostToolBridge } from "./ask-team";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paws-artifacts-"));
  roots.push(root);
  return root;
}

test("artifact snapshot retains immutable bytes, MIME and hash after file changes", async () => {
  const root = await workspace();
  await writeFile(join(root, "screenshot.png"), "original bytes");
  const artifact = await snapshotArtifactFile(root, {
    path: "screenshot.png",
    displayName: "Dashboard.png",
  });
  await writeFile(join(root, "screenshot.png"), "replacement bytes");
  expect(await artifact.bytes.text()).toBe("original bytes");
  const copy = new Uint8Array(await artifact.bytes.arrayBuffer());
  copy.fill(0);
  expect(await artifact.bytes.text()).toBe("original bytes");
  expect(artifact.sizeBytes).toBe(Buffer.byteLength("original bytes"));
  expect(artifact.mimeType).toBe("image/png");
  expect(artifact.displayName).toBe("Dashboard.png");
  expect(artifact.sha256).toBe(createHash("sha256").update("original bytes").digest("hex"));
});

test("artifact guard rejects traversal, absolute paths, directories and symlink escapes", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "outside.txt"), "private");
  await symlink(outside, join(root, "escape"));
  await mkdir(join(root, "directory"));
  for (const path of [
    "../outside.txt",
    join(outside, "outside.txt"),
    "escape/outside.txt",
    "directory",
  ]) {
    await expect(snapshotArtifactFile(root, { path })).rejects.toThrow();
  }
});

test.each([
  ".env",
  ".env.local",
  ".git/config",
  ".config/gh/hosts.yml",
  "secrets/data.json",
  "credentials.json",
  "client.key",
])("artifact guard rejects secret path %s and aliases to it", async (path) => {
  const root = await workspace();
  const { dirname } = await import("node:path");
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), "private");
  await symlink(join(root, path), join(root, "export.txt"));
  await expect(snapshotArtifactFile(root, { path })).rejects.toThrow("secrets or credentials");
  await expect(snapshotArtifactFile(root, { path: "export.txt" })).rejects.toThrow(
    "secrets or credentials",
  );
});

test("artifact byte limit and cancellation prevent snapshots", async () => {
  const root = await workspace();
  await writeFile(join(root, "report.txt"), "12345");
  await expect(snapshotArtifactFile(root, { path: "report.txt" }, { maxBytes: 4 })).rejects.toThrow(
    "exceeds 4 bytes",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    snapshotArtifactFile(root, { path: "report.txt" }, {}, controller.signal),
  ).rejects.toThrow();
});

test("bridge close aborts a held upload and destroys sockets awaiting a request", async () => {
  const root = await workspace();
  await writeFile(join(root, "report.txt"), "report");
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => (ready = resolve));
  let signal: AbortSignal | undefined;
  const bridge = await startHostToolBridge({
    socketPath: join(root, "tools.sock"),
    context: { itemId: "item", runId: "run", worktreePath: root, role: "implementer" },
    signal: new AbortController().signal,
    publishArtifact: {
      publish: async (_artifact, context) => {
        signal = context.signal;
        ready();
        return new Promise(() => undefined);
      },
    },
  });
  const held = connect(join(root, "tools.sock"));
  const upload = connect(join(root, "tools.sock"));
  held.on("error", () => undefined);
  upload.on("error", () => undefined);
  upload.write(
    `${JSON.stringify({ id: 1, tool: "publish_artifact", arguments: { path: "report.txt" } })}\n`,
  );
  await entered;
  await bridge.close();
  expect(signal?.aborted).toBe(true);
  held.destroy();
  upload.destroy();
});

test("cancellation prevents a waiting artifact request from launching an upload", async () => {
  const root = await workspace();
  await writeFile(join(root, "report.txt"), "report");
  const controller = new AbortController();
  let uploads = 0;
  const bridge = await startHostToolBridge({
    socketPath: join(root, "tools.sock"),
    context: { itemId: "item", runId: "run", worktreePath: root, role: "implementer" },
    signal: controller.signal,
    publishArtifact: {
      publish: async () => {
        uploads += 1;
        return { url: "https://uploads.example/report.txt" };
      },
    },
  });
  const socket = connect(join(root, "tools.sock"));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  controller.abort();
  socket.write(
    `${JSON.stringify({ id: 1, tool: "publish_artifact", arguments: { path: "report.txt" } })}\n`,
  );
  await bridge.close();
  expect(uploads).toBe(0);
  socket.destroy();
});
