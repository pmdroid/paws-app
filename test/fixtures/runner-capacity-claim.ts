import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../../src/db";
import { createRunnerWork } from "../../src/runner-work";

const [path, keyPath, commandPath, barrier, at] = process.argv.slice(2);
const db = openDatabase(path!);
try {
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: createPrivateKey(readFileSync(keyPath!)),
    now: () => Number(at),
  });
  const command = JSON.parse(readFileSync(commandPath!, "utf8"));
  writeFileSync(`${commandPath}.ready`, "ready");
  while (!existsSync(barrier!)) await delay(5);
  try {
    work.assign(command);
    console.log(JSON.stringify({ accepted: true, commandId: command.id }));
  } catch (error) {
    console.log(JSON.stringify({ accepted: false, commandId: command.id, error: String(error) }));
  }
} finally {
  db.close();
}
