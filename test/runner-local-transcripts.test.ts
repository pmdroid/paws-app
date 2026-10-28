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
import { createHash } from "node:crypto";
import { createLocalRunnerTranscriptObjects } from "../src/runner-transcripts";
import {
  configureRunnerTranscriptStorage,
  loadRunnerTranscriptObjects,
} from "../src/runner-transcript-config";
import { probeRunnerTranscripts } from "./local/runner-transcripts";

const file = (root: string, key: string) =>
  join(root, createHash("sha256").update(key).digest("hex") + ".jsonl");
const text = async (read: Promise<Uint8Array>) => Buffer.from(await read).toString();

test("local transcript configuration persists protected files across reconstruction", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-local-transcripts-"));
  try {
    configureRunnerTranscriptStorage(home, JSON.stringify({ kind: "local" }));
    const objects = loadRunnerTranscriptObjects(home);
    await objects.write("first", Buffer.from("original"));
    expect(statSync(join(home, "runner-transcripts")).mode & 0o777).toBe(0o700);
    expect(statSync(file(join(home, "runner-transcripts"), "first")).mode & 0o777).toBe(0o600);
    expect(await text(loadRunnerTranscriptObjects(home).read("first"))).toBe("original");
    await objects.write("first", Buffer.from("replacement"));
    expect(await text(objects.read("first"))).toBe("replacement");
    await objects.write("../../escape", Buffer.from("bounded key"));
    expect(statSync(file(join(home, "runner-transcripts"), "../../escape")).isFile()).toBe(true);
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

test("oversized transcript writes preserve the previous object and remove temporary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-local-transcripts-"));
  try {
    const objects = createLocalRunnerTranscriptObjects(root);
    await objects.write("key", Buffer.from("previous"));
    await expect(objects.write("key", new Uint8Array(524_288 + 29))).rejects.toThrow(
      "Transcript chunk exceeds size limit",
    );
    expect(await text(objects.read("key"))).toBe("previous");
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
    await objects.write("key", Buffer.from("owned"));
    const path = file(directory, "key");
    rmSync(path);
    const outside = join(root, "outside");
    writeFileSync(outside, "private", { mode: 0o600 });
    symlinkSync(outside, path);
    await expect(objects.read("key")).rejects.toThrow();
    rmSync(path);
    linkSync(outside, path);
    await expect(objects.read("key")).rejects.toThrow();
    rmSync(path);
    await objects.write("key", Buffer.from("owned"));
    chmodSync(path, 0o644);
    await expect(objects.read("key")).rejects.toThrow("Unsafe transcript file");
    chmodSync(directory, 0o755);
    await expect(objects.read("key")).rejects.toThrow("Unsafe transcript directory");
    await expect(createLocalRunnerTranscriptObjects(directory).read("key")).rejects.toThrow();
    const alias = join(root, "alias");
    symlinkSync(directory, alias);
    await expect(createLocalRunnerTranscriptObjects(alias).read("key")).rejects.toThrow();
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
