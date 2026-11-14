import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useDatabaseSecrets } from "../src/credentials";
import { createFakeRunnerTranscriptObjects } from "../src/runner-transcripts";
import {
  loadRunnerTranscriptS3,
  loadRunnerTranscriptStores,
} from "../src/runner-transcript-config";
import { handleStorageSettingsRequest, type StorageSettingsOptions } from "../src/settings";
import { forEachDialect } from "./dialects";

const NAMES = [
  "PAWS_S3_BUCKET",
  "PAWS_S3_ENDPOINT",
  "PAWS_S3_REGION",
  "PAWS_S3_ACCESS_KEY_ID",
  "PAWS_S3_SECRET_ACCESS_KEY",
  "PAWS_S3_SESSION_TOKEN",
  "PAWS_SECRET_KEY",
];
const url = "http://127.0.0.1:8787/api/settings/storage";
const s3 = {
  kind: "s3",
  bucket: "paws-objects",
  endpoint: "https://objects.example.invalid",
  region: "eu-central-1",
  accessKeyId: "AKIAEXAMPLE",
};
let saved: Record<string, string | undefined>;
let home: string;
let audits: string[];
const cleanup: (() => unknown)[] = [];

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  home = mkdtempSync(join(tmpdir(), "paws-storage-settings-"));
  audits = [];
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  for (const name of NAMES)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  rmSync(home, { recursive: true, force: true });
});

function options(extra: Partial<StorageSettingsOptions> = {}): StorageSettingsOptions {
  return {
    home,
    csrfToken: "csrf",
    audit: async (action, subject) => {
      audits.push(`${action}: ${subject}`);
    },
    ...extra,
  };
}

function send(method: string, body?: unknown, path = ""): Request {
  return new Request(`${url}${path}`, {
    method,
    headers: {
      "x-paws-csrf": "csrf",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(request: Request, extra: Partial<StorageSettingsOptions> = {}) {
  const response = (await handleStorageSettingsRequest(request, options(extra)))!;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function roundTrip() {
  loadRunnerTranscriptStores(home);
  expect((await call(send("GET"))).body).toMatchObject({ kind: "local", source: "default" });
  const put = await call(
    send("PUT", { ...s3, secretAccessKey: "top-secret", sessionToken: "tok" }),
  );
  expect(put).toEqual({
    status: 200,
    body: {
      ...s3,
      hasSecretAccessKey: true,
      hasSessionToken: true,
      source: "settings",
      restartRequired: true,
    },
  });
  expect((await call(send("GET"))).body).toEqual({
    ...s3,
    hasSecretAccessKey: true,
    hasSessionToken: true,
    source: "settings",
  });
  const kept = await call(send("PUT", { ...s3, region: "us-east-1" }));
  expect(kept.body).toMatchObject({ region: "us-east-1", hasSecretAccessKey: true });
  expect(loadRunnerTranscriptS3(home)?.bucket).toBe("paws-objects");
  expect((await call(send("PUT", { ...s3, region: "us-east-1" }))).body.restartRequired).toBe(true);
  expect((await call(send("PUT", { kind: "local" }))).body.restartRequired).toBe(false);
  expect(audits).toHaveLength(4);
  expect(audits.join("\n")).not.toMatch(/top-secret|tok\b/);
  expect(audits[1]).toContain("secret access key kept");
}

test("PUT then GET round-trips everything except the secrets", roundTrip);

forEachDialect((connect) => {
  test("the settings save to the database secret table", async () => {
    process.env.PAWS_SECRET_KEY = randomBytes(32).toString("base64");
    const handle = await connect();
    cleanup.push(() => handle.close());
    const secrets = await useDatabaseSecrets(handle.db, join(home, "secrets"));
    cleanup.push(() => secrets.close());
    await roundTrip();
  });
});

test("with PAWS_S3_* set GET reports the environment and PUT gets 409", async () => {
  process.env.PAWS_S3_BUCKET = "env-bucket";
  process.env.PAWS_S3_SECRET_ACCESS_KEY = "env-secret";
  const get = await call(send("GET"));
  expect(get.body).toMatchObject({
    kind: "s3",
    bucket: "env-bucket",
    hasSecretAccessKey: true,
    source: "environment",
  });
  expect(JSON.stringify(get.body)).not.toContain("env-secret");
  expect(await call(send("PUT", { kind: "local" }))).toEqual({
    status: 409,
    body: { error: "Storage is set by PAWS_S3_* environment variables on this host." },
  });
});

test("the check writes, reads and deletes one object and reports an S3 failure", async () => {
  const fake = createFakeRunnerTranscriptObjects();
  const body = { ...s3, secretAccessKey: "top-secret" };
  expect(await call(send("POST", body, "/check"), { objects: () => fake })).toEqual({
    status: 200,
    body: { ok: true },
  });
  expect(fake.writes).toHaveLength(1);
  expect(fake.deletes).toEqual(fake.writes);
  expect(fake.objects.size).toBe(0);
  const failing = {
    ...fake,
    write: async () => {
      throw new Error("Access Denied");
    },
  };
  expect((await call(send("POST", body, "/check"), { objects: () => failing })).body).toEqual({
    ok: false,
    error: "Access Denied",
  });
  expect((await call(send("GET"))).body.source).toBe("default");
  expect((await call(send("POST", undefined, "/check"))).status).toBe(400);
  expect((await call(send("POST", { ...s3 }, "/check"))).body.error).toContain("secretAccessKey");
  expect(audits).toEqual([]);
});

test("members, a missing CSRF token and invalid values are refused", async () => {
  for (const method of ["GET", "PUT", "POST"])
    expect(
      (
        await call(send(method, { kind: "local" }, method === "POST" ? "/check" : ""), {
          role: "member",
        })
      ).status,
    ).toBe(403);
  const noCsrf = new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: '{"kind":"local"}',
  });
  expect((await call(noCsrf)).status).toBe(403);
  const invalid = await call(send("PUT", { ...s3, bucket: "Bad Bucket", secretAccessKey: "x" }));
  expect(invalid).toEqual({ status: 400, body: { error: "Invalid storage settings: bucket." } });
  expect((await call(send("GET"))).body.source).toBe("default");
  expect(audits).toEqual([]);
});

forEachDialect((connect) => {
  test("Closeout log retention defaults to 14 days and saves without touching storage", async () => {
    const { db: store, close } = await connect();
    cleanup.push(close);
    expect((await call(send("GET"), { store })).body.closeoutLogRetentionDays).toBe(14);
    const put = await call(send("PUT", { closeoutLogRetentionDays: 0 }), { store });
    expect(put).toMatchObject({ status: 200, body: { closeoutLogRetentionDays: 0 } });
    expect((await call(send("GET"), { store })).body).toMatchObject({
      source: "default",
      closeoutLogRetentionDays: 0,
    });
    for (const days of [-1, 1.5, "7", 3651])
      expect((await call(send("PUT", { closeoutLogRetentionDays: days }), { store })).status).toBe(
        400,
      );
    expect(audits).toEqual(["settings.storage: Set Closeout log retention: keep forever"]);
  });
});

forEachDialect((connect) => {
  test("rejected combined storage updates preserve retention", async () => {
    const { db: store, close } = await connect();
    cleanup.push(close);
    expect(
      (
        await call(send("PUT", { ...s3, bucket: "Bad Bucket", closeoutLogRetentionDays: 0 }), {
          store,
        })
      ).status,
    ).toBe(400);
    expect((await call(send("GET"), { store })).body.closeoutLogRetentionDays).toBe(14);
    process.env.PAWS_S3_BUCKET = "env-bucket";
    process.env.PAWS_S3_SECRET_ACCESS_KEY = "env-secret";
    expect(
      (await call(send("PUT", { kind: "local", closeoutLogRetentionDays: 0 }), { store })).status,
    ).toBe(409);
    expect((await call(send("GET"), { store })).body.closeoutLogRetentionDays).toBe(14);
    expect(audits).toEqual([]);
    expect((await call(send("PUT", { closeoutLogRetentionDays: 0 }), { store })).status).toBe(200);
  });
});
