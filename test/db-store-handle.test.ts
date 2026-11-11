import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, migrate, openDatabase, sqliteDb, startLoops } from "../src/db";
import { startPaws } from "../src/index";
import { attachOrchestrator } from "../src/loop";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { serverStore } from "../src/server";
import { tempHome } from "./helpers";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database() {
  const root = mkdtempSync(join(tmpdir(), "paws-store-"));
  roots.push(root);
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  return { db, root };
}

test("startup holds one store, sqliteDb() of its database", async () => {
  const paws = await startPaws({ PAWS_HOME: tempHome(), PAWS_PORT: "0", PAWS_HOST: "127.0.0.1" });
  try {
    expect(paws.store).toBe(sqliteDb(paws.db));
  } finally {
    await paws.stop();
  }
});

test("the job loop and the outbox dispatcher hold the store they are given", async () => {
  const { db } = database();
  const store = sqliteDb(db);
  const abort = new AbortController();
  abort.abort();
  const loops = await startLoops({
    db,
    store,
    instanceId: "store",
    role: "web",
    signal: abort.signal,
  });
  expect(loops.jobs.store).toBe(store);
  expect(loops.outbox.store).toBe(store);
  expect(new JobLoop(db, systemClock).store).toBe(store);
  expect(new OutboxDispatcher(db, systemClock).store).toBe(store);
  db.close();
});

test("the orchestrator holds the store it is given", () => {
  const { db, root } = database();
  const store = sqliteDb(db);
  const jobs = new JobLoop(db, systemClock, { store });
  const outbox = new OutboxDispatcher(db, systemClock, { store });
  expect(attachOrchestrator({ db, store, jobs, outbox, pawsRoot: root }).store).toBe(store);
  expect(attachOrchestrator({ db, jobs, outbox, pawsRoot: root }).store).toBe(store);
  db.close();
});

test("the server's routes reach the store it is given", () => {
  const { db } = database();
  const store = sqliteDb(db);
  expect(serverStore({ db, store })).toBe(store);
  expect(serverStore({ db })).toBe(store);
  expect(serverStore({})).toBeUndefined();
  db.close();
});

test("the runner backend holds the store it is given", () => {
  const { db } = database();
  const store = sqliteDb(db);
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const options = {
    db,
    work,
    results: createRunnerResults({ db, work }),
    health: createRunnerHealth({ db, work }),
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
  };
  expect(createRemoteAgentRunner({ ...options, store }).store).toBe(store);
  expect(createRemoteAgentRunner(options).store).toBe(store);
  db.close();
});
