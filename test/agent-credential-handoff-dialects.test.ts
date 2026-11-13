import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../src/credentials";
import { createAgentAccountSteps } from "../src/db";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  agentCredentialContext,
  openForRunner,
  signRunnerCommand,
  type RunnerCommand,
} from "../src/runner-protocol";
import { createRunnerWork } from "../src/runner-work";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: DialectDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const files = [{ path: ".codex/auth.json", data: Buffer.from('{"token":"a"}').toString("base64") }];

forEachDialect((connect) => {
  test("only a runner that knows stored sign-ins gets one, sealed to its enrollment key", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const root = mkdtempSync(join(tmpdir(), "paws-credential-handoff-"));
    dirs.push(root);
    const authority = await initializeRunnerAuthority(join(root, "issuer"));
    const key = await createRunnerKey(root);
    const issued = await authority.issue(key.csr);
    for (const workspace of ["acme", "beta"])
      await seed(db, (q) =>
        q.orm.insert(q.t.workspace).values({
          id: workspace,
          linearOrganizationId: workspace,
          name: workspace,
          createdAt: 0,
        }),
      );
    await seed(db, (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "acme",
        userId: "owner",
        role: "admin",
        source: "manual",
        active: 1,
        checkedAt: 0,
      }),
    );
    for (const [runnerId, runnerVersion] of [
      ["old", "0.1.81"],
      ["new", "0.1.82"],
    ] as const) {
      await seedRunner(db, runnerId);
      await seed(db, (q) =>
        q.orm.insert(q.t.runnerHostStatus).values({ runnerId, runnerVersion, reportedAt: 0 }),
      );
      await seed(db, (q) =>
        q.orm.insert(q.t.runnerCertificate).values({
          fingerprint: `${runnerId}-${issued.fingerprint}`,
          serial: `${runnerId}-${issued.serial}`,
          runnerId,
          pem: issued.pem,
          notBefore: 0,
          notAfter: NOW * 2,
          acceptedUntil: NOW * 2,
        }),
      );
    }
    const account = (workspaceId: string, label: string) =>
      db.transaction((q) =>
        createAgentAccountSteps(q, { workspaceId, agent: "codex", label, now: NOW }),
      );
    const stored = (await account("acme", "Stored")).id;
    const fresh = (await account("acme", "Fresh")).id;
    const foreign = (await account("beta", "Foreign")).id;
    const secretsDir = join(root, "secrets");
    await db.transaction((q) =>
      writeAgentCredentialSteps(q, secretsDir, {
        accountId: stored,
        runnerId: "old",
        version: 1,
        blob: JSON.stringify(files),
        now: NOW,
      }),
    );
    const signing = generateKeyPairSync("ed25519");
    const work = createRunnerWork({
      store: db,
      keyId: "coordinator",
      privateKey: signing.privateKey,
      eventKey: randomBytes(32),
      secretsDir,
      now: () => NOW,
    });
    const envelope = (runnerId: string, type: "login" | "login_check", id: string) =>
      signRunnerCommand({
        keyId: "coordinator",
        privateKey: signing.privateKey,
        command: {
          id,
          type,
          runnerId,
          workspaceId: "acme",
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
          agent: "codex",
          account: { accountId: stored, bindingId: "binding" },
        } as RunnerCommand,
      });

    const old = envelope("old", "login_check", "check-old");
    expect(await work.attachCredentials("old", [old])).toEqual([old]);

    const [check] = await work.attachCredentials("new", [envelope("new", "login_check", "check")]);
    expect(check!.credential?.version).toBe(1);
    const blob = openForRunner(
      readFileSync(key.keyPath, "utf8"),
      check!.credential!.sealed!,
      agentCredentialContext("check", stored, 1),
    );
    expect(JSON.parse(blob)).toEqual(files);
    expect(() =>
      openForRunner(
        readFileSync(key.keyPath, "utf8"),
        check!.credential!.sealed!,
        agentCredentialContext("other", stored, 1),
      ),
    ).toThrow();

    const [login] = await work.attachCredentials("new", [envelope("new", "login", "login")]);
    expect(login!.credential).toEqual({ version: 1 });

    expect(await work.storeCredential("new", { accountId: stored, version: 2, files })).toBe(
      "written",
    );
    expect(await work.storeCredential("new", { accountId: stored, version: 2, files })).toBe(
      "written",
    );
    expect(await work.storeCredential("old", { accountId: stored, version: 2, files })).toBe(
      "stale_version",
    );
    expect(await work.storeCredential("new", { accountId: fresh, version: 1, files })).toBe(
      "written",
    );
    const created = await db.run((q) => readAgentCredentialSteps(q, secretsDir, fresh));
    expect(created).toMatchObject({ version: 1, runnerId: "new", agent: "codex" });
    expect(JSON.parse(created!.blob)).toEqual(files);
    expect((await db.run((q) => readAgentCredentialSteps(q, secretsDir, stored)))?.version).toBe(2);
    await expect(
      work.storeCredential("new", { accountId: foreign, version: 1, files }),
    ).rejects.toThrow();
  }, 30_000);
});
