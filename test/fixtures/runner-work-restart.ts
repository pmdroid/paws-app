import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { openPawsStore } from "../../src/db";
import { createRunnerWork } from "../../src/runner-work";

const [url, keyPath, runnerId, at] = process.argv.slice(2);
const { store, close } = await openPawsStore({ url: url!, pgliteDir: "" });
try {
  const work = createRunnerWork({
    store,
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
  await close();
}
