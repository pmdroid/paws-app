import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../src/credentials";
import {
  agentCredentialCiphertextSteps,
  centralAgentAccountsSteps,
  createAgentAccountSteps,
  type Db,
} from "../src/db";
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: PgliteTestDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(connect: () => Promise<PgliteTestDb>) {
  const handle = await connect();
  open.push(handle);
  const { db } = handle;
  await withoutForeignKeys(db);
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "acme", linearOrganizationId: "org", name: "acme", createdAt: NOW }),
  );
  await seedRunner(db, "R1");
  await seedRunner(db, "R2");
  const account = (label: string) =>
    db.transaction((q) =>
      createAgentAccountSteps(q, {
        ownerUserId: "owner",
        workspaceId: "acme",
        agent: "claude",
        label,
        now: NOW,
      }),
    );
  const secrets = mkdtempSync(join(tmpdir(), "paws-agent-credential-"));
  dirs.push(secrets);
  return { db, secrets, first: (await account("First")).id, second: (await account("Second")).id };
}

const signIn = (db: Db, accountId: string, ciphertext = "sealed") =>
  seed(db, (q) =>
    q.orm
      .insert(q.t.agentAccountCredential)
      .values({ accountId, agent: "claude", ciphertext, version: 1, updatedAt: NOW }),
  );

const candidates = (db: Db) =>
  db
    .run((q) => centralAgentAccountsSteps(q, "acme", "claude"))
    .then((rows) => rows.map((row) => row.id));

describePglite((connect) => {
  test("a sign-in round-trips encrypted and only the next version is written", async () => {
    const { db, secrets, first } = await setup(connect);
    const write = (runnerId: string, version: number, blob: string, now = NOW) =>
      db.transaction((q) =>
        writeAgentCredentialSteps(q, secrets, { accountId: first, runnerId, version, blob, now }),
      );
    const plaintext = '{"claudeAiOauth":{"refreshToken":"rt-secret-1"}}';
    expect(await write("R1", 1, plaintext)).toBe("written");
    const stored = await db.run((q) => agentCredentialCiphertextSteps(q, first));
    expect(stored?.ciphertext.startsWith("paws-envelope-v1\n")).toBe(true);
    expect(stored?.ciphertext).not.toContain("rt-secret-1");
    expect(await db.run((q) => readAgentCredentialSteps(q, secrets, first))).toMatchObject({
      agent: "claude",
      blob: plaintext,
      version: 1,
      runnerId: "R1",
    });

    expect(await write("R1", 1, "old")).toBe("stale_version");
    expect(await write("R1", 3, "skipped")).toBe("stale_version");
    expect(await write("R1", 2, "rotated")).toBe("written");

    expect(await write("R2", 3, "fresh")).toBe("written");
    expect((await db.run((q) => readAgentCredentialSteps(q, secrets, first)))?.blob).toBe("fresh");
  });

  test("placement skips a Claude account with no stored credential or an empty one", async () => {
    const { db, first, second } = await setup(connect);
    expect(await candidates(db)).toEqual([]);
    await signIn(db, first, "");
    await signIn(db, second);
    expect(await candidates(db)).toEqual([second]);
  });
});
