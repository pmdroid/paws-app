import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureRunnerTranscriptStorage, loadRunnerTranscriptS3 } from ".";

const NAMES = [
  "PAWS_S3_BUCKET",
  "PAWS_S3_ENDPOINT",
  "PAWS_S3_REGION",
  "PAWS_S3_ACCESS_KEY_ID",
  "PAWS_S3_SECRET_ACCESS_KEY",
  "PAWS_S3_SESSION_TOKEN",
  "PAWS_SECRET_KEY",
];
const FAILURE = "Runner transcript storage configuration is missing or invalid.";
const stored = {
  bucket: "stored-transcripts",
  endpoint: "https://objects.example.invalid",
  region: "stored-region",
  accessKeyId: "stored-key",
  secretAccessKey: "stored-secret",
};
let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  root = mkdtempSync(join(tmpdir(), "paws-s3-env-test-"));
});

afterEach(() => {
  for (const name of NAMES)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  rmSync(root, { recursive: true, force: true });
});

function setEnv() {
  process.env.PAWS_S3_BUCKET = "env-transcripts";
  process.env.PAWS_S3_ENDPOINT = "https://s3.example.invalid";
  process.env.PAWS_S3_REGION = "env-region";
  process.env.PAWS_S3_ACCESS_KEY_ID = "env-key";
  process.env.PAWS_S3_SECRET_ACCESS_KEY = "env-secret";
}

test("PAWS_S3_* variables configure the bucket without a stored file", () => {
  setEnv();
  const home = join(root, "home");
  expect(loadRunnerTranscriptS3(home)?.bucket).toBe("env-transcripts");
  const url = new URL(loadRunnerTranscriptS3(home)!.client.presign("key"));
  expect(url.hostname).toContain("s3.example.invalid");
  expect(url.searchParams.get("X-Amz-Security-Token")).toBeNull();
});

test("PAWS_S3_* variables take precedence over a stored bucket", () => {
  const home = join(root, "home");
  configureRunnerTranscriptStorage(home, JSON.stringify(stored));
  expect(loadRunnerTranscriptS3(home)?.bucket).toBe("stored-transcripts");
  setEnv();
  expect(loadRunnerTranscriptS3(home)?.bucket).toBe("env-transcripts");
});

test("PAWS_S3_SESSION_TOKEN reaches the presigned URL", () => {
  setEnv();
  process.env.PAWS_S3_SESSION_TOKEN = "env-session-token";
  const s3 = loadRunnerTranscriptS3(join(root, "home"))!;
  expect(new URL(s3.client.presign("key")).searchParams.get("X-Amz-Security-Token")).toBe(
    "env-session-token",
  );
});

test("a partial or invalid PAWS_S3_* set fails closed", () => {
  const home = join(root, "home");
  configureRunnerTranscriptStorage(home, JSON.stringify(stored));
  for (const name of NAMES.slice(0, 5)) {
    setEnv();
    delete process.env[name];
    expect(() => loadRunnerTranscriptS3(home)).toThrow(FAILURE);
    setEnv();
    process.env[name] = "";
    expect(() => loadRunnerTranscriptS3(home)).toThrow(FAILURE);
  }
  setEnv();
  process.env.PAWS_S3_ENDPOINT = "http://s3.example.invalid";
  expect(() => loadRunnerTranscriptS3(home)).toThrow(FAILURE);
  setEnv();
  process.env.PAWS_S3_SESSION_TOKEN = "";
  expect(() => loadRunnerTranscriptS3(home)).toThrow(FAILURE);
});

test("without PAWS_S3_* variables the stored configuration decides", () => {
  const home = join(root, "home");
  expect(loadRunnerTranscriptS3(home)).toBeNull();
  configureRunnerTranscriptStorage(home, JSON.stringify(stored));
  expect(loadRunnerTranscriptS3(home)?.bucket).toBe("stored-transcripts");
  configureRunnerTranscriptStorage(home, JSON.stringify({ kind: "local" }));
  expect(loadRunnerTranscriptS3(home)).toBeNull();
});
