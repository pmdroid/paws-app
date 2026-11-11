import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteDb, beginImplementRun, insertQueuedItem, migrate, openDatabase } from "../src/db";
import { createFakeRunFileObjects, createSealedRunnerFiles } from "../src/run-files";
import { createRunnerArtifactStore, RUNNER_ARTIFACT_CHUNK_BYTES } from "../src/runner-artifacts";
import { createRunnerInputStore } from "../src/runner-inputs";
import type { RunnerArtifact, RunnerCommand } from "../src/runner-protocol";
import type { RunnerWork } from "../src/runner-work";

const DAY = 24 * 60 * 60 * 1000;
const KEY = Buffer.alloc(32, 9);

async function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  let clock = Date.parse("2026-11-07T06:00:00Z");
  const item = await insertQueuedItem(db, {
    id: "acme-item",
    now: clock,
    sessionKey: "acme-session",
  });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, clock);
  const command = { type: "run", id: "acme-command", runId: run.id } as Extract<
    RunnerCommand,
    { type: "run" }
  >;
  const work = {
    authorizeAsync: async () => ({ command }),
    currentAsync: async () => ({ command }),
  } as unknown as RunnerWork;
  const objects = createFakeRunFileObjects();
  const instance = (root = mkdtempSync(join(tmpdir(), "paws-acme-instance-"))) => {
    const files = createSealedRunnerFiles({
      store: sqliteDb(db),
      objects,
      key: KEY,
      now: () => clock,
    });
    return {
      root,
      files,
      inputs: createRunnerInputStore({ root: join(root, "inputs"), work, remote: files }),
      artifacts: createRunnerArtifactStore({
        root: join(root, "artifacts"),
        work,
        remote: { files, db },
      }),
    };
  };
  const access = { runnerId: "acme-runner", runId: run.id, token: "acme-token" };
  return {
    db,
    run,
    command,
    work,
    objects,
    access,
    instance,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

const attachment = Buffer.from("Acme quarterly report: private attachment\n".repeat(20_000));

describe("runner inputs and artifacts in the shared store", () => {
  test("an input staged through instance A is served to the runner by instance B", async () => {
    const { command, access, instance } = await fixture();
    const a = instance();
    const b = instance();
    command.inputFiles = await a.inputs.stage(
      command.id,
      [{ path: "acme/report.txt", mimeType: "text/plain", bytes: attachment }],
      access.runId,
    );
    command.promptContext = await a.inputs.stagePrompt(command.id, "Acme context", access.runId);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < attachment.length;) {
      const chunk = await b.inputs.read(access, {
        commandId: command.id,
        generation: 1,
        fileId: 0,
        offset,
      });
      const bytes = Buffer.from(chunk.data, "base64");
      chunks.push(bytes);
      offset += bytes.length;
    }
    expect(Buffer.concat(chunks)).toEqual(attachment);
    const context = await b.inputs.readContext(access, {
      commandId: command.id,
      generation: 1,
      offset: 0,
    });
    expect(Buffer.from(context.data, "base64").toString()).toBe("Acme context");
    expect(readdirSync(join(a.root, "inputs"))).toEqual([]);
  });

  test("stored inputs are ciphertext, and a read returns the plaintext", async () => {
    const { command, access, objects, instance } = await fixture();
    const a = instance();
    const secret = Buffer.from("acme-private-attachment-contents");
    command.inputFiles = await a.inputs.stage(
      command.id,
      [{ path: "acme.txt", mimeType: "text/plain", bytes: secret }],
      access.runId,
    );
    const key = `runner-inputs/${access.runId}/${command.id}/0/0`;
    expect([...objects.objects.keys()]).toEqual([key]);
    const stored = Buffer.from(objects.objects.get(key)!);
    expect(stored.includes(secret)).toBe(false);
    expect(stored.length).toBe(secret.length + 28);
    expect(await a.files.read(key, command.inputFiles[0]!.sha256)).toEqual(secret);
    await expect(a.files.read(key, "0".repeat(64))).rejects.toThrow();
    await expect(
      a.inputs.stage(
        command.id,
        [{ path: "acme.txt", mimeType: "text/plain", bytes: Buffer.from("changed") }],
        access.runId,
      ),
    ).rejects.toThrow("immutable");
  });

  test("an artifact uploaded through instance A is published by instance B", async () => {
    const { access, objects, instance } = await fixture();
    const a = instance();
    const b = instance();
    const bytes = Buffer.alloc(RUNNER_ARTIFACT_CHUNK_BYTES + 19, 65);
    const artifact: RunnerArtifact = {
      id: randomUUID(),
      path: "evidence/acme.txt",
      displayName: "Acme",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      attachToIssue: false,
    };
    for (const index of [0, 1])
      await a.artifacts.upload({
        ...access,
        chunk: {
          generation: 1,
          artifact,
          index,
          data: bytes
            .subarray(
              index * RUNNER_ARTIFACT_CHUNK_BYTES,
              (index + 1) * RUNNER_ARTIFACT_CHUNK_BYTES,
            )
            .toString("base64"),
        },
      });
    const snapshot = await b.artifacts.snapshot(access.runId, 1, artifact);
    expect(Buffer.from(await snapshot.bytes.arrayBuffer())).toEqual(bytes);
    expect(objects.objects.size).toBe(2);
    for (const stored of objects.objects.values())
      expect(Buffer.from(stored).includes(Buffer.alloc(64, 65))).toBe(false);
    expect(readdirSync(join(a.root, "artifacts"))).toEqual([]);

    const empty = (id: string) => ({
      ...access,
      chunk: {
        generation: 1,
        index: 0,
        data: "",
        artifact: {
          ...artifact,
          id,
          sizeBytes: 0,
          sha256: createHash("sha256").update("").digest("hex"),
        },
      },
    });
    for (let count = 1; count < 20; count++) await b.artifacts.upload(empty(randomUUID()));
    await expect(a.artifacts.upload(empty(randomUUID()))).rejects.toThrow("at most 20 artifacts");
  });

  test("inputs are pruned 7 days after the run ends", async () => {
    const { db, run, command, access, objects, instance, advance, now } = await fixture();
    const a = instance();
    command.inputFiles = await a.inputs.stage(
      command.id,
      [{ path: "acme.txt", mimeType: "text/plain", bytes: Buffer.from("acme") }],
      access.runId,
    );
    advance(30 * DAY);
    expect(await a.files.prune()).toBe(0);
    db.run("UPDATE run SET status='ended', updated_at=? WHERE id=?", [now(), run.id]);
    advance(7 * DAY - 1);
    expect(await a.files.prune()).toBe(0);
    expect(objects.objects.size).toBe(1);
    advance(2);
    expect(await a.files.prune()).toBe(1);
    expect(objects.objects.size).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM runner_file_object").get()).toEqual({ n: 0 });
  });

  test("without the shared store, inputs and artifacts stay on local disk as before", async () => {
    const { command, access, work } = await fixture();
    const root = mkdtempSync(join(tmpdir(), "paws-acme-local-"));
    const inputs = createRunnerInputStore({ root: join(root, "inputs"), work });
    command.inputFiles = await inputs.stage(
      command.id,
      [{ path: "acme.txt", mimeType: "text/plain", bytes: Buffer.from("acme") }],
      access.runId,
    );
    const folder = join(root, "inputs", createHash("sha256").update(command.id).digest("hex"));
    expect(existsSync(join(folder, "0.bytes"))).toBe(true);
    const chunk = await inputs.read(access, {
      commandId: command.id,
      generation: 1,
      fileId: 0,
      offset: 0,
    });
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("acme");
  });

  test("an input staged on local disk before the store was configured still reads", async () => {
    const { command, access, work, instance } = await fixture();
    const a = instance();
    const local = createRunnerInputStore({ root: join(a.root, "inputs"), work });
    command.inputFiles = await local.stage(command.id, [
      { path: "acme.txt", mimeType: "text/plain", bytes: Buffer.from("acme") },
    ]);
    const chunk = await a.inputs.read(access, {
      commandId: command.id,
      generation: 1,
      fileId: 0,
      offset: 0,
    });
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("acme");
  });

  test("files staged on local disk before S3 was configured are uploaded once at startup", async () => {
    const { command, access, work, objects, instance } = await fixture();
    const root = mkdtempSync(join(tmpdir(), "paws-acme-before-"));
    const local = createRunnerInputStore({ root: join(root, "inputs"), work });
    const localArtifacts = createRunnerArtifactStore({ root: join(root, "artifacts"), work });
    command.inputFiles = await local.stage(command.id, [
      { path: "acme.txt", mimeType: "text/plain", bytes: attachment },
    ]);
    command.promptContext = await local.stagePrompt(command.id, "Acme context");
    const bytes = Buffer.from("acme evidence");
    const artifact: RunnerArtifact = {
      id: randomUUID(),
      path: "evidence/acme.txt",
      displayName: "Acme",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      attachToIssue: false,
    };
    await localArtifacts.upload({
      ...access,
      chunk: { generation: 1, artifact, index: 0, data: bytes.toString("base64") },
    });
    const a = instance(root);
    const commands = [{ id: command.id, runId: access.runId }];
    expect(await a.inputs.migrateLocal(commands)).toBe(1);
    expect(await a.artifacts.migrateLocal(commands)).toBe(1);
    expect(readdirSync(join(root, "inputs"))).toEqual([]);
    expect(readdirSync(join(root, "artifacts"))).toEqual([]);
    expect(await a.inputs.migrateLocal(commands)).toBe(0);

    const b = instance();
    const first = await b.inputs.read(access, {
      commandId: command.id,
      generation: 1,
      fileId: 0,
      offset: 0,
    });
    expect(Buffer.from(first.data, "base64")).toEqual(
      attachment.subarray(0, RUNNER_ARTIFACT_CHUNK_BYTES),
    );
    const context = await b.inputs.readContext(access, {
      commandId: command.id,
      generation: 1,
      offset: 0,
    });
    expect(Buffer.from(context.data, "base64").toString()).toBe("Acme context");
    const snapshot = await b.artifacts.snapshot(access.runId, 1, artifact);
    expect(Buffer.from(await snapshot.bytes.arrayBuffer())).toEqual(bytes);
    for (const stored of objects.objects.values())
      expect(Buffer.from(stored).includes(Buffer.from("Acme quarterly"))).toBe(false);
  });

  test("an artifact chunk retried with other bytes of the same length is refused", async () => {
    const { access, objects, instance } = await fixture();
    const a = instance();
    const b = instance();
    const bytes = Buffer.from("acme-one");
    const artifact: RunnerArtifact = {
      id: randomUUID(),
      path: "evidence/acme.txt",
      displayName: "Acme",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      attachToIssue: false,
    };
    const upload = (data: Buffer) => ({
      ...access,
      chunk: { generation: 1, artifact, index: 0, data: data.toString("base64") },
    });
    await a.artifacts.upload(upload(bytes));
    const stored = objects.objects.get([...objects.objects.keys()][0]!)!;
    await b.artifacts.upload(upload(bytes));
    await expect(b.artifacts.upload(upload(Buffer.from("acme-two")))).rejects.toThrow("immutable");
    expect(objects.writes).toHaveLength(2);
    const snapshot = await a.artifacts.snapshot(access.runId, 1, artifact);
    expect(Buffer.from(await snapshot.bytes.arrayBuffer())).toEqual(bytes);
    expect(stored.length).toBe(bytes.length + 28);
  });

  test("the database keeps no plain hash of a stored chunk", async () => {
    const { db, command, access, instance } = await fixture();
    const a = instance();
    const secret = Buffer.from("acme-short-secret");
    command.inputFiles = await a.inputs.stage(
      command.id,
      [{ path: "acme.txt", mimeType: "text/plain", bytes: secret }],
      access.runId,
    );
    const row = db.query("SELECT sha256 FROM runner_file_object").get() as { sha256: string };
    expect(row.sha256).not.toBe(createHash("sha256").update(secret).digest("hex"));
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("an artifact upload during a storage outage answers 503, not a refusal", async () => {
    const { db, work, access } = await fixture();
    const objects = createFakeRunFileObjects();
    objects.write = async () => {
      throw Object.assign(new Error("acme bucket unreachable"), { code: "ECONNRESET" });
    };
    const root = mkdtempSync(join(tmpdir(), "paws-acme-outage-"));
    const artifacts = createRunnerArtifactStore({
      root: join(root, "artifacts"),
      work,
      remote: { files: createSealedRunnerFiles({ store: sqliteDb(db), objects, key: KEY }), db },
    });
    const bytes = Buffer.from("acme evidence");
    const artifact: RunnerArtifact = {
      id: randomUUID(),
      path: "evidence/acme.txt",
      displayName: "Acme",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      attachToIssue: false,
    };
    const response = await artifacts.fetch(
      new Request(`https://runner.invalid/v1/runs/${access.runId}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${"a".repeat(43)}` },
        body: JSON.stringify({
          generation: 1,
          artifact,
          index: 0,
          data: bytes.toString("base64"),
        }),
      }),
      access.runnerId,
    );
    expect(response!.status).toBe(503);
  });
});
