import "../quiet-journal";
import { storeLinearToken } from "../helpers";
import { join } from "node:path";
import {
  migrate,
  openDatabase,
  recordLinearInstallation,
  revokeLinearInstallation,
  sqliteDb,
} from "../../src/db";
import { startPaws } from "../../src/index";

const home = process.argv[2]!;
const db = openDatabase(join(home, "paws.db"));
migrate(db);
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
await revokeLinearInstallation(sqliteDb(db), { ...scope, eventKey: "revoked", createdAtMs: 2 });
db.close();
storeLinearToken(home, {
  accessToken: "fake-access",
  refreshToken: "fake-refresh",
  expiresAtMs: 0,
  scope: "read,write",
  actor: "app",
});
let requests = 0;
globalThis.fetch = Object.assign(
  async () => {
    requests++;
    throw new Error("Offline request must not run");
  },
  { preconnect: () => undefined },
);
const paws = startPaws({
  PAWS_HOME: home,
  PAWS_PORT: "0",
  LINEAR_MODE: "agent-session",
  LINEAR_CLIENT_ID: "client",
  LINEAR_CLIENT_SECRET: "fake-secret",
});
await paws.catchUp();
paws.stop();
console.log(JSON.stringify({ requests }));
