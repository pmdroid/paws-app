import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { openDatabase, sqliteDb } from "../../src/db";
import { createRunnerWork } from "../../src/runner-work";

const [path, keyPath, runnerId, at] = process.argv.slice(2);
const db = openDatabase(path!);
try {
  const work = createRunnerWork({
    store: sqliteDb(db),
    keyId: "fixture",
    privateKey: createPrivateKey(readFileSync(keyPath!)),
    eventKey: Buffer.alloc(32, 7),
    now: () => Number(at),
  });
  console.log(
    JSON.stringify({
      commands: (await work.commands(runnerId!)).map(
        (value) => JSON.parse(Buffer.from(value.payload, "base64url").toString("utf8")).id,
      ),
    }),
  );
} finally {
  db.close();
}
