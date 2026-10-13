import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDatabase } from "../../src/db";
import { startServer } from "../../src/server";

const root = process.argv[2];
if (!root) throw new Error("Provide a disposable runner setup evidence directory");
mkdirSync(root, { recursive: true, mode: 0o700 });
const db = openDatabase(join(root, "paws.sqlite"));
migrate(db);
const server = startServer({
  hostname: "127.0.0.1",
  port: 0,
  db,
  webhooks: false,
  statusEnv: {},
});
const origin = `http://127.0.0.1:${server.port}`;
writeFileSync(join(root, "fixture.json"), JSON.stringify({ origin }));
console.log(JSON.stringify({ origin }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  await server.stop(true);
  db.close();
}
const deadline = setTimeout(() => void stop(), 300_000);
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
