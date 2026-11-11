import { generateKeyPairSync } from "node:crypto";
import { migrate, openDatabase, sqliteDb } from "../../src/db";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerWork } from "../../src/runner-work";

const [path, runnerId, commandId, timestamp] = process.argv.slice(2);
if (!path || !runnerId || !commandId || !timestamp)
  throw new Error("Missing health recovery input");
const db = openDatabase(path);
try {
  migrate(db);
  const work = createRunnerWork({
    store: sqliteDb(db),
    keyId: "read-only-fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const health = createRunnerHealth({ store: sqliteDb(db), work, now: () => Number(timestamp) });
  console.log(JSON.stringify({ pid: process.pid, result: await health.read(runnerId, commandId) }));
} finally {
  db.close();
}
