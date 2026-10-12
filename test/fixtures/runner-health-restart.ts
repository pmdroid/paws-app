import { generateKeyPairSync } from "node:crypto";
import { migrate, openDatabase } from "../../src/db";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerWork } from "../../src/runner-work";

const [path, runnerId, commandId, timestamp] = process.argv.slice(2);
if (!path || !runnerId || !commandId || !timestamp)
  throw new Error("Missing health recovery input");
const db = openDatabase(path);
try {
  migrate(db);
  const work = createRunnerWork({
    db,
    keyId: "read-only-fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const health = createRunnerHealth({ db, work, now: () => Number(timestamp) });
  console.log(JSON.stringify({ pid: process.pid, result: health.read(runnerId, commandId) }));
} finally {
  db.close();
}
