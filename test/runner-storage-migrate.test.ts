import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentSessionObjectKey, createLocalAgentSessionObjects } from "../src/agent-sessions";
import { sqliteDb } from "../src/db";
import { createFakeRunFileObjects } from "../src/run-files";
import { migrateRunnerStorage } from "../src/runner-transcript-config";
import {
  createLocalRunnerTranscriptObjects,
  runnerTranscriptObjectKey,
} from "../src/runner-transcripts";
import { legacyTempDb, tempHome } from "./helpers";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const chunks = [randomBytes(64), randomBytes(32)].map((bytes, index) => ({
  bytes,
  offset: index * 524_288,
  sha256: sha(bytes),
}));
const row = { workspaceId: "w", commandId: "c", executionId: "e", runId: "run", generation: 1 };
const transcriptKeys = chunks.map((chunk) => runnerTranscriptObjectKey({ ...row, ...chunk }));
const sessionKeys = chunks.map((chunk) => agentSessionObjectKey({ ...row, ...chunk }));
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true })));

async function fixture() {
  const db = legacyTempDb();
  const home = tempHome();
  homes.push(home);
  db.exec("PRAGMA foreign_keys=OFF");
  db.run(`INSERT INTO runner_transcript(run_id,generation,command_id,workspace_id,execution_id)
    VALUES('run',1,'c','w','e')`);
  db.run(`INSERT INTO agent_session_snapshot(run_id,generation,item_id,workspace_id,runner_id,
    created_at) VALUES('run',1,'item','w','runner',1)`);
  db.run(`INSERT INTO runner_transcript_chunk(run_id,generation,offset,size_bytes,sha256)
    VALUES('run',1,1048576,1,'${"0".repeat(64)}')`);
  const transcripts = createLocalRunnerTranscriptObjects(join(home, "runner-transcripts"));
  const sessions = createLocalAgentSessionObjects(join(home, "agent-sessions"));
  for (const [index, chunk] of chunks.entries()) {
    for (const table of ["runner_transcript_chunk", "agent_session_snapshot_chunk"])
      db.run(
        `INSERT INTO ${table}(run_id,generation,offset,size_bytes,sha256,key_id)
        VALUES('run',1,?,?,?,?)`,
        [chunk.offset, chunk.bytes.length, chunk.sha256, "k".repeat(64)],
      );
    await transcripts.write(transcriptKeys[index]!, chunk.bytes);
    await sessions.write(sessionKeys[index]!, chunk.bytes);
  }
  const files = (folder: string) => readdirSync(join(home, folder));
  return { home, store: sqliteDb(db), files };
}

test("migrate copies every sealed chunk of both kinds once and a rerun copies nothing", async () => {
  const { home, store, files } = await fixture();
  const remote = createFakeRunFileObjects();
  const migrate = () => migrateRunnerStorage({ home, store, deleteLocal: false, remote });
  const counts = { copied: 2, bytes: 96, present: 0, missing: 0, deleted: 0 };
  expect(await migrate()).toEqual({ transcripts: counts, agentSessions: counts });
  expect(remote.writes.sort()).toEqual([...transcriptKeys, ...sessionKeys].sort());
  expect(remote.objects.get(sessionKeys[1]!)).toEqual(new Uint8Array(chunks[1]!.bytes));
  const again = { copied: 0, bytes: 0, present: 2, missing: 0, deleted: 0 };
  expect(await migrate()).toEqual({ transcripts: again, agentSessions: again });
  expect(remote.writes).toHaveLength(4);
  expect([...files("runner-transcripts"), ...files("agent-sessions")]).toHaveLength(4);
});

test("--delete-local removes only the files whose objects read back", async () => {
  const { home, store, files } = await fixture();
  const fake = createFakeRunFileObjects();
  const write = (key: string, bytes: Uint8Array) =>
    fake.write(key, key === sessionKeys[0] ? randomBytes(bytes.length) : bytes);
  const migrate = () =>
    migrateRunnerStorage({ home, store, deleteLocal: true, remote: { ...fake, write } });
  const report = await migrate();
  expect(report.transcripts.deleted).toBe(2);
  expect(report.agentSessions).toMatchObject({ copied: 2, deleted: 1 });
  expect(files("runner-transcripts")).toEqual([]);
  expect(files("agent-sessions")).toEqual([`${sha(Buffer.from(sessionKeys[0]!))}.bin`]);
  const rerun = await migrate();
  expect(rerun.transcripts).toMatchObject({ copied: 0, missing: 2 });
  expect(rerun.agentSessions).toMatchObject({ present: 1, missing: 1, deleted: 0 });
});
