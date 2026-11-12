import { generateKeyPairSync } from "node:crypto";
import { openPawsStore } from "../../src/db";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerWork } from "../../src/runner-work";

const [url, runnerId, commandId, timestamp] = process.argv.slice(2);
if (!url || !runnerId || !commandId || !timestamp) throw new Error("Missing health recovery input");
const { store, close } = await openPawsStore({ url, pgliteDir: "" });
try {
  const work = createRunnerWork({
    store,
    keyId: "read-only-fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const health = createRunnerHealth({ store, work, now: () => Number(timestamp) });
  console.log(JSON.stringify({ pid: process.pid, result: await health.read(runnerId, commandId) }));
} finally {
  await close();
}
