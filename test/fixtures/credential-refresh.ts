import "../quiet-journal";
import { join } from "node:path";
import { migrate, openDatabase } from "../../src/db";
import { refreshCredential } from "../../src/credentials";
import { readStoredToken, refreshLinearToken, writeStoredToken } from "../../src/linear";

const [home, endpoint, crash] = process.argv.slice(2) as [string, string, string];
const db = openDatabase(join(home, "paws.db"));
migrate(db);
const secretsDir = join(home, "secrets");
await refreshCredential({
  db,
  identity: "linear",
  read: () => readStoredToken(db, secretsDir),
  write: (token) => writeStoredToken(db, secretsDir, token),
  leaseMs: 1_000,
  refresh: async (current, signal) =>
    refreshLinearToken({
      refreshToken: current.refreshToken!,
      clientId: "synthetic-client",
      clientSecret: "synthetic-client-secret",
      fetch: async (_url, init) => {
        const response = await fetch(endpoint, { ...init, signal });
        if (crash === "crash") {
          console.log("provider rotated");
          await new Promise(() => {});
        }
        return response;
      },
    }),
});
console.log("refresh complete");
db.close();
