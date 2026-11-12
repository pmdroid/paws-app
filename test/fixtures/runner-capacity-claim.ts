import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { openPawsStore } from "../../src/db";
import { createRunnerWork } from "../../src/runner-work";

const [url, keyPath, commandPath, barrier, at] = process.argv.slice(2);
const { store, close } = await openPawsStore({ url: url!, pgliteDir: "" });
try {
  const work = createRunnerWork({
    store,
    keyId: "fixture",
    privateKey: createPrivateKey(readFileSync(keyPath!)),
    eventKey: Buffer.alloc(32, 7),
    now: () => Number(at),
  });
  const command = JSON.parse(readFileSync(commandPath!, "utf8"));
  writeFileSync(`${commandPath}.ready`, "ready");
  while (!existsSync(barrier!)) await delay(5);
  try {
    await work.assign(command);
    console.log(JSON.stringify({ accepted: true, commandId: command.id }));
  } catch (error) {
    console.log(JSON.stringify({ accepted: false, commandId: command.id, error: String(error) }));
  }
} finally {
  await close();
}
