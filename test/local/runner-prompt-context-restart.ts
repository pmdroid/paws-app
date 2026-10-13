import { createHash, generateKeyPairSync } from "node:crypto";
import { openDatabase } from "../../src/db";
import { createRunnerInputStore } from "../../src/runner-inputs";
import { RUNNER_INPUT_CHUNK_BYTES } from "../../src/runner-protocol";
import { createRunnerWork } from "../../src/runner-work";

const input = await Bun.stdin.json();
const db = openDatabase(input.dbPath);
try {
  const work = createRunnerWork({
    db,
    keyId: "restart",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => input.now,
  });
  const store = createRunnerInputStore({ root: input.root, work });
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (let offset = 0; offset < input.sizeBytes; offset += RUNNER_INPUT_CHUNK_BYTES) {
    const chunk = store.readContext(
      { runnerId: input.runnerId, runId: input.runId, token: input.token },
      { commandId: input.commandId, generation: input.generation, offset },
    );
    const bytes = Buffer.from(chunk.data, "base64");
    hash.update(bytes);
    sizeBytes += bytes.length;
  }
  console.log(JSON.stringify({ sizeBytes, sha256: hash.digest("hex") }));
} finally {
  db.close();
}
