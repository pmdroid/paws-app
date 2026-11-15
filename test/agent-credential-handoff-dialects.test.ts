import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../src/credentials";
import {
  createAgentAccountSteps,
  writeAgentAuthSteps,
  assignRunnerWorkSteps,
  bindAgentAccountSteps,
  insertRunnerLoginSteps,
  runnerLoginRowSteps,
  runnerResultForCommandSteps,
  healthResultJsonSteps,
  insertRunnerCommandSteps,
} from "../src/db";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  RunnerResultSchema,
  RunnerHealthResultSchema,
  agentCredentialContext,
  openForRunner,
  signRunnerCommand,
  type RunnerCommand,
} from "../src/runner-protocol";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner, seedCommand } from "./runner-rows";

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
    const envelope = (
      runnerId: string,
      type: "login" | "login_check",
      id: string,
      agent: "codex" | "claude" = "codex",
      accountId = stored,
    ) =>
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
          agent,
          account: { accountId, bindingId: "binding" },
        } as RunnerCommand,
      });

    const oauthClaude = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        workspaceId: "acme",
        agent: "claude",
        label: "OAuth",
        now: NOW,
      }),
    );
    await db.transaction((q) =>
      writeAgentCredentialSteps(q, secretsDir, {
        accountId: oauthClaude.id,
        runnerId: "old",
        version: 1,
        blob: JSON.stringify([{ path: ".claude/paws-oauth.json", data: "e30=" }]),
        now: NOW,
      }),
    );
    await db.run((q) =>
      insertRunnerLoginSteps(q, {
        id: "stale",
        runnerId: "old",
        workspaceId: "acme",
        userId: "owner",
        agent: "claude",
        expiresAt: NOW + 60000,
        updatedAt: NOW,
        bindingId: null,
      }),
    );
    const compatible = envelope("old", "login", "compatible");
    for (const signed of [envelope("old", "login", "stale", "claude", oauthClaude.id), compatible])
      await db.run((q) =>
        insertRunnerCommandSteps(q, {
          id: signed === compatible ? "compatible" : "stale",
          runnerId: "old",
          runId: null,
          generation: null,
          kind: "login",
          envelope: signed,
          expiresAt: NOW + 60000,
        }),
      );
    for (let poll = 0; poll < 2; poll++)
      expect((await work.commands("old")).map((entry) => entry.payload)).toEqual([
        compatible.payload,
      ]);

    expect((await db.run((q) => runnerLoginRowSteps(q, "stale")))?.state).toBe("failed");
    for (const type of ["run", "login_check"] as const) {
      const command = {
        ...JSON.parse(
          Buffer.from(
            envelope("old", "login_check", type, "claude", oauthClaude.id).payload,
            "base64url",
          ).toString("utf8"),
        ),
        ...(type === "run"
          ? {
              type,
              agent: undefined,
              itemId: "item",
              runId: "run",
              generation: 1,
              repository: {
                owner: "acme",
                repo: "app",
                remoteUrl: "https://github.com/acme/app.git",
                baseSha: "a".repeat(40),
              },
              profile: { agent: "claude", model: null },
              prompt: "test",
            }
          : { type }),
      };
      delete command.agent;
      if (type === "login_check") command.agent = "claude";
      const signed = signRunnerCommand({
        keyId: "coordinator",
        privateKey: signing.privateKey,
        command,
      });
      expect(
        (await work.attachCredentials("old", [signed, compatible])).map((entry) => entry.payload),
      ).toEqual([compatible.payload]);
      const result = await db.run((q) =>
        type === "run"
          ? runnerResultForCommandSteps(q, command, type)
          : healthResultJsonSteps(q, type),
      );
      expect(
        (type === "run" ? RunnerResultSchema : RunnerHealthResultSchema).parse(JSON.parse(result!))
          .errorMessage,
      ).toContain("Upgrade the runner");
    }

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
    expect(JSON.parse(created!.blob!)).toEqual(files);
    expect((await db.run((q) => readAgentCredentialSteps(q, secretsDir, stored)))?.version).toBe(2);
    await expect(
      work.storeCredential("new", { accountId: foreign, version: 1, files }),
    ).rejects.toThrow();
    await db.transaction((q) =>
      writeAgentAuthSteps(q, stored, JSON.stringify({ state: "signed-in" })),
    );
    const http = createRunnerWorkHttp(work);
    const upload = (accountId: string, version = 3) =>
      new Request("https://runner/v1/agent-credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, version, files }),
      });
    expect((await http(upload(stored), "new"))?.status).toBe(409);
    await expect(work.attachCredentials("old", [old])).rejects.toThrow();
    await expect(
      work.attachCredentials("new", [envelope("new", "login_check", "too-old")]),
    ).rejects.toThrow();
    const claude = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        workspaceId: "acme",
        agent: "claude",
        label: "Claude",
        now: NOW,
      }),
    );
    expect((await http(upload(claude.id, 1), "new"))?.status).toBe(200);
    await seed(db, (q) => q.orm.update(q.t.runnerHostStatus).set({ runnerVersion: "0.1.83" }));
    const centralFiles = [
      {
        path: ".codex/auth.json",
        data: Buffer.from(
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: { access_token: "access", refresh_token: "refresh" },
          }),
        ).toString("base64"),
      },
    ];
    await db.transaction((q) =>
      writeAgentCredentialSteps(q, secretsDir, {
        accountId: stored,
        runnerId: null,
        version: 3,
        blob: JSON.stringify(centralFiles),
        now: NOW,
      }),
    );
    const [central] = await work.attachCredentials("new", [
      envelope("new", "login_check", "central"),
    ]);
    const decoded = JSON.parse(
      openForRunner(
        readFileSync(key.keyPath, "utf8"),
        central!.credential!.sealed!,
        agentCredentialContext("central", stored, 3),
      ),
    );
    expect(JSON.parse(Buffer.from(decoded[0].data, "base64").toString()).tokens.refresh_token).toBe(
      "",
    );
    await expect(work.currentCredential("new", stored)).rejects.toThrow();
    const binding = await db.transaction((q) =>
      bindAgentAccountSteps(q, {
        workspaceId: "acme",
        accountId: stored,
        runnerId: "new",
        now: NOW,
      }),
    );
    await seedCommand(db, "bound-run", {
      runnerId: "new",
      runId: "run",
      kind: "run",
      generation: 1,
      expiresAt: NOW + 60_000,
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCommandAccount).values({
        commandId: "bound-run",
        runnerId: "new",
        workspaceId: "acme",
        agent: "codex",
        accountId: stored,
        bindingId: binding.id,
        named: 1,
        recordedAt: NOW,
      }),
    );
    await db.transaction((q) =>
      assignRunnerWorkSteps(q, {
        runId: "run",
        runnerId: "new",
        workspaceId: "acme",
        generation: 1,
        runnerFence: 0,
        commandId: "bound-run",
        leaseUntil: NOW + 60_000,
      }),
    );
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.agentAccountLease)))).toEqual([]);
    expect(
      (
        await http(
          new Request("https://runner/v1/agent-credentials/current", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ accountId: stored }),
          }),
          "new",
        )
      )?.status,
    ).toBe(200);
    const current = await work.currentCredential("new", stored);
    expect(
      JSON.parse(
        openForRunner(
          readFileSync(key.keyPath, "utf8"),
          current.sealed,
          agentCredentialContext("current", stored, 3),
        ),
      ),
    ).toEqual(decoded);
    await expect(work.currentCredential("old", stored)).rejects.toThrow();
    expect((await db.run((q) => readAgentCredentialSteps(q, secretsDir, stored)))?.version).toBe(3);
    await seed(db, (q) => q.orm.update(q.t.agentAccountBinding).set({ removedAt: NOW }));
    await expect(work.currentCredential("new", stored)).rejects.toThrow();
    await seed(db, (q) => q.orm.update(q.t.agentAccountBinding).set({ removedAt: null }));
    await seed(db, (q) => q.orm.update(q.t.runnerWork).set({ endedAt: NOW }));
    await expect(work.currentCredential("new", stored)).rejects.toThrow();
    await seed(db, (q) => q.orm.update(q.t.runnerWork).set({ endedAt: null, leaseUntil: NOW - 1 }));
    await expect(work.currentCredential("new", stored)).rejects.toThrow();
    await seed(db, (q) =>
      q.orm.update(q.t.runnerWork).set({ leaseUntil: NOW + 60_000, runnerFence: 1 }),
    );
    await expect(work.currentCredential("new", stored)).rejects.toThrow();
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerHelper).values({
        id: "helper",
        runnerId: "new",
        workspaceId: "acme",
        sessionId: "session",
        sessionGeneration: 1,
        runnerFence: 0,
        envelope: {},
        expiresAt: NOW + 60_000,
      }),
    );
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCommandAccount).values({
        commandId: "helper",
        runnerId: "new",
        workspaceId: "acme",
        accountId: stored,
        bindingId: binding.id,
        agent: "codex",
        named: 1,
        recordedAt: NOW,
      }),
    );
    expect((await work.currentCredential("new", stored)).version).toBe(3);
    await expect(work.currentCredential("old", stored)).rejects.toThrow();
    for (const denied of [
      { endedAt: NOW },
      { endedAt: null, result: {} },
      { result: null, expiresAt: NOW - 1 },
      { expiresAt: NOW + 60_000, runnerFence: 1 },
    ]) {
      await seed(db, (q) => q.orm.update(q.t.runnerHelper).set(denied));
      await expect(work.currentCredential("new", stored)).rejects.toThrow();
    }
  }, 30_000);
});
