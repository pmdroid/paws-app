import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalRunnerTranscriptObjects,
  RUNNER_TRANSCRIPT_MAX_BYTES,
} from "../src/runner-transcripts";
import {
  configureRunnerTranscriptStorage,
  loadRunnerTranscriptObjects,
} from "../src/runner-transcript-config";
import { probeRunnerTranscripts } from "./local/runner-transcripts";

test("local transcript configuration persists protected files across reconstruction", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-local-transcripts-"));
  try {
    configureRunnerTranscriptStorage(home, JSON.stringify({ kind: "local" }));
    const objects = loadRunnerTranscriptObjects(home);
    await objects.write("first", new Blob(["original"]));
    expect(statSync(join(home, "runner-transcripts")).mode & 0o777).toBe(0o700);
    expect(statSync(fileURLToPath(objects.uri("first"))).mode & 0o777).toBe(0o600);
    expect(await new Response(loadRunnerTranscriptObjects(home).read("first")).text()).toBe(
      "original",
    );
    await objects.write("first", new Blob(["replacement"]));
    expect(await new Response(objects.read("first")).text()).toBe("replacement");
    await objects.write("../../escape", new Blob(["bounded key"]));
    expect(fileURLToPath(objects.uri("../../escape"))).toStartWith(
      join(home, "runner-transcripts") + "/",
    );
    expect(readdirSync(join(home, "runner-transcripts"))).toHaveLength(2);
    expect(
      readFileSync(join(home, "secrets", "runner-transcript-storage.json"), "utf8"),
    ).toStartWith("paws-envelope-v1\n");
    expect(() =>
      configureRunnerTranscriptStorage(home, '{"kind":"local","path":"/tmp"}'),
    ).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("interrupted and oversized transcript writes preserve the previous object and remove temporary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-local-transcripts-"));
  try {
    const objects = createLocalRunnerTranscriptObjects(root);
    await objects.write("key", new Blob(["previous"]));
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      pull(controller) {
        controller.error(new Error("Synthetic stream failure"));
      },
    });
    await expect(objects.write("key", interrupted)).rejects.toThrow("Synthetic stream failure");
    await expect(
      objects.write("key", new Blob([new Uint8Array(RUNNER_TRANSCRIPT_MAX_BYTES + 1)])),
    ).rejects.toThrow("Transcript exceeds size limit");
    expect(await new Response(objects.read("key")).text()).toBe("previous");
    expect(readdirSync(root)).toHaveLength(1);
    const locked = new Blob(["locked"]).stream();
    const reader = locked.getReader();
    await expect(objects.write("key", locked)).rejects.toThrow();
    reader.releaseLock();
    expect(readdirSync(root)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local transcript reads reject symlinks, hard links and unsafe permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-local-transcripts-"));
  const directory = join(root, "objects");
  try {
    const objects = createLocalRunnerTranscriptObjects(directory);
    const path = fileURLToPath(objects.uri("key"));
    const outside = join(root, "outside");
    writeFileSync(outside, "private", { mode: 0o600 });
    symlinkSync(outside, path);
    expect(() => objects.read("key")).toThrow();
    rmSync(path);
    linkSync(outside, path);
    expect(() => objects.read("key")).toThrow();
    rmSync(path);
    await objects.write("key", new Blob(["owned"]));
    chmodSync(path, 0o644);
    expect(() => objects.read("key")).toThrow("Unsafe transcript file");
    chmodSync(directory, 0o755);
    expect(() => objects.read("key")).toThrow("Unsafe transcript directory");
    expect(() => createLocalRunnerTranscriptObjects(directory)).toThrow();
    const alias = join(root, "alias");
    symlinkSync(directory, alias);
    expect(() => createLocalRunnerTranscriptObjects(alias)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("private");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local disk preserves real paired-runner transcript grants, streaming, retries and digest checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-local-transcripts-"));
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  try {
    await probeRunnerTranscripts(
      join(root, "proof"),
      (name, passed, observed) => observations.push({ name, passed, observed }),
      createLocalRunnerTranscriptObjects(join(root, "objects")),
    );
    expect(observations.length).toBeGreaterThan(5);
    expect(observations.every((entry) => entry.passed)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
