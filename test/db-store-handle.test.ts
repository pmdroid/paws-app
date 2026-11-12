import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, startLoops } from "../src/db";
import { startPaws } from "../src/index";
import { attachOrchestrator } from "../src/loop";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { serverStore } from "../src/server";
import { migratedHome } from "./helpers";
import { tempStore } from "./pglite";

const roots: string[] = [];
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function database() {
  const root = mkdtempSync(join(tmpdir(), "paws-store-"));
  roots.push(root);
  const { db, close } = await tempStore();
  open.push(close);
  return { db, root };
}

test("startup holds one store on Postgres", async () => {
  const paws = await startPaws({
    PAWS_HOME: await migratedHome(),
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
  });
  try {
    expect(paws.store.dialect).toBe("postgres");
  } finally {
    await paws.stop();
  }
});

test("the job loop and the outbox dispatcher hold the store they are given", async () => {
  const { db: store } = await database();
  const abort = new AbortController();
  abort.abort();
  const loops = await startLoops({
    db: store,
    store,
    instanceId: "store",
    role: "web",
    signal: abort.signal,
  });
  expect(loops.jobs.store).toBe(store);
  expect(loops.outbox.store).toBe(store);
  expect(new JobLoop(store, systemClock).store).toBe(store);
  expect(new OutboxDispatcher(store, systemClock).store).toBe(store);
});

test("the orchestrator holds the store it is given", async () => {
  const { db: store, root } = await database();
  const jobs = new JobLoop(store, systemClock, { store });
  const outbox = new OutboxDispatcher(store, systemClock, { store });
  expect(attachOrchestrator({ store, jobs, outbox, pawsRoot: root }).store).toBe(store);
});

test("the server's routes reach the store it is given", async () => {
  const { db: store } = await database();
  expect(serverStore({ db: store, store })).toBe(store);
  expect(serverStore({ db: store })).toBe(store);
  expect(serverStore({})).toBeUndefined();
});

test("the runner backend holds the store it is given", async () => {
  const { db: store } = await database();
  const work = createRunnerWork({
    store: store,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const options = {
    work,
    results: createRunnerResults({ store: store, work }),
    health: createRunnerHealth({ store: store, work }),
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
  };
  expect(createRemoteAgentRunner({ ...options, store }).store).toBe(store);
});
