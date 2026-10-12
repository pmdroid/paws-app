import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, runnerForCertificate } from "../../src/db";
import { createRunnerControl } from "../../src/runner-control";
import { openRunnerAuthority, startRunnerListener } from "../../src/runner-identity";

const root = process.argv[2]!;
const db = openDatabase(join(root, "paws.sqlite"));
let listener: Awaited<ReturnType<typeof startRunnerListener>>;
const control = createRunnerControl({
  db,
  authority: await openRunnerAuthority(join(root, "issuer")),
  certificateRoot: join(root, "issuer"),
  disconnect: (fingerprint) => listener.revoke(fingerprint),
});
listener = await startRunnerListener({
  tls: {
    key: readFileSync(join(root, "server.key"), "utf8"),
    cert: readFileSync(join(root, "server.pem"), "utf8"),
    ca: readFileSync(join(root, "authority.pem"), "utf8"),
  },
  authorize(peer) {
    return runnerForCertificate(db, peer.fingerprint, Date.now()) !== null;
  },
  async fetch(_request, peer) {
    const runner = runnerForCertificate(db, peer.fingerprint, Date.now());
    return runner ? Response.json(runner) : new Response(null, { status: 403 });
  },
});
const timer = setInterval(() => control.expireConnections(), 1000);
console.log(JSON.stringify({ port: listener.port }));
async function stop() {
  clearInterval(timer);
  await listener.stop();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
