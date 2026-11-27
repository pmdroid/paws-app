import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentCredentialSteps } from "../src/credentials";
import { createAgentAccountSteps, writeAgentAuthSteps, type Q } from "../src/db";
import { createRetroDispatcher } from "../src/retros";
import { openRunnerAccountHome, RunnerAccountHomeError } from "../src/runner-execution";
import { createRunnerHelpers } from "../src/runner-helpers";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  agentCredentialContext,
  openForRunner,
  signRunnerCommand,
  signRunnerRetroCommand,
  type RunnerAccount,
  type RunnerCommand,
  type RunnerRetroCommand,
  type SignedRunnerCommand,
} from "../src/runner-protocol";
import { createRunnerWork, createRunnerWorkHttp, RunnerWorkFencedError } from "../src/runner-work";
import {
  describePglite,
  json,
  seed,
  withoutForeignKeys,
  type PgliteTestDb,
} from "./pglite-fixtures";
import { signInRunnerAccount } from "./runner-account-home";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: PgliteTestDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const files = (data: string) => [
  { path: ".codex/auth.json", data: Buffer.from(data).toString("base64") },
];
const signing = generateKeyPairSync("ed25519");
const sign = (command: RunnerCommand) =>
  signRunnerCommand({ keyId: "coordinator", privateKey: signing.privateKey, command });
const signRetro = (command: RunnerRetroCommand) =>
  signRunnerRetroCommand({ keyId: "coordinator", privateKey: signing.privateKey, command });
const common = (id: string) => ({
  id,
  runnerId: "R",
  workspaceId: "acme",
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
});
const loginCheck = (id: string, account: RunnerAccount): RunnerCommand => ({
  ...common(id),
  type: "login_check",
  agent: "codex",
  account,
});
const helper = (id: string, account: RunnerAccount): RunnerCommand => ({
  ...common(id),
  type: "helper",
  sessionId: "probes-distill",
  sessionGeneration: 0,
  purpose: "probe_distill",
  profile: { agent: "codex", model: "fixture-model" },
  prompt: "Distill these sources.",
  account,
});
const input = (kind: "digest" | "prompt") => ({
  kind,
  workspaceId: "acme",
  retroId: "retro",
  sha256: "0".repeat(64),
  sizeBytes: 1,
});
const retro = (id: string, account: RunnerAccount, attempt: number): RunnerRetroCommand => ({
  ...common(id),
  type: "retro",
  capability: 1,
  retroId: "retro",
  attempt,
  settingsRevision: 1,
  profile: { agent: "codex", model: "fixture-model" },
  account,
  executionLimit: { activeMinutes: 15 },
  output: { maxItems: 5, workedWell: 3, maxChars: 4_000 },
  digest: input("digest"),
  prompt: input("prompt"),
});
const payload = (envelope: SignedRunnerCommand) =>
  JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as { id: string };

describePglite((connect) => {
  test("an unsealable sign-in fails only its own command on every delivery path", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const root = mkdtempSync(join(tmpdir(), "paws-unsealable-"));
    dirs.push(root);
    const authority = await initializeRunnerAuthority(join(root, "issuer"));
    const key = await createRunnerKey(root);
    const issued = await authority.issue(key.csr);
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.workspace)
          .values({ id: "acme", linearOrganizationId: "acme", name: "acme", createdAt: 0 }),
      (q) =>
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id: "owner", linearUserId: "owner", name: "Owner", email: "owner@x" }),
      (q) =>
        q.orm.insert(q.t.workspaceMember).values({
          workspaceId: "acme",
          userId: "owner",
          role: "admin",
          source: "manual",
          active: 1,
          checkedAt: 0,
        }),
    );
    await seedRunner(db, "R");
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCertificate).values({
        fingerprint: issued.fingerprint,
        serial: issued.serial,
        runnerId: "R",
        pem: issued.pem,
        notBefore: 0,
        notAfter: NOW * 2,
        acceptedUntil: NOW * 2,
      }),
    );
    const secretsDir = join(root, "secrets");
    const account = async (label: string, blob: string, central: boolean) => {
      const { id } = await db.transaction((q) =>
        createAgentAccountSteps(q, {
          ownerUserId: "owner",
          workspaceId: "acme",
          agent: "codex",
          label,
          now: NOW,
        }),
      );
      await db.transaction((q) =>
        writeAgentCredentialSteps(q, secretsDir, {
          accountId: id,
          runnerId: central ? null : "R",
          version: 1,
          blob: JSON.stringify(files(blob)),
          now: NOW,
        }),
      );
      if (central)
        await db.transaction((q) =>
          writeAgentAuthSteps(q, id, JSON.stringify({ state: "signed-in" })),
        );
      return { accountId: id, bindingId: `binding-${label}` };
    };
    const first = await account("first", '{"token":"first"}', false);
    const second = await account("second", '{"token":"second"}', false);
    const unsealable = await account("unsealable", "{}", true);

    const work = createRunnerWork({
      store: db,
      keyId: "coordinator",
      privateKey: signing.privateKey,
      eventKey: randomBytes(32),
      secretsDir,
      now: () => NOW,
    });
    const credentials = (runnerId: string, envelopes: SignedRunnerCommand[]) =>
      work.attachCredentials(runnerId, envelopes);
    const helpers = createRunnerHelpers({
      store: db,
      keyId: "coordinator",
      privateKey: signing.privateKey,
      now: () => NOW,
      credentials,
      *probes() {
        yield* [];
        return true;
      },
    });
    const retros = createRetroDispatcher({
      store: db,
      artifactRoot: join(root, "retros"),
      sign: signRetro,
      credentials,
      now: () => NOW,
    });
    const workHttp = createRunnerWorkHttp(work);
    const get = (path: string) => new Request(`https://runner${path}`, { method: "GET" });
    const helperCommands = async () => {
      const response = (await helpers.fetch(get("/v1/helper-commands"), "R"))!;
      return {
        status: response.status,
        commands: ((await response.json()) as { commands?: SignedRunnerCommand[] }).commands,
      };
    };

    const plantedHome = join(root, "agent-home");
    mkdirSync(plantedHome, { mode: 0o700 });
    signInRunnerAccount(plantedHome, "codex", first);
    mkdirSync(join(plantedHome, ".codex"));
    writeFileSync(join(plantedHome, ".codex", "auth.json"), '{"token":"ambient"}');

    const expectBatch = (delivered: SignedRunnerCommand[], expected: [string, RunnerAccount][]) => {
      expect(delivered.map((envelope) => payload(envelope).id)).toEqual(expected.map(([id]) => id));
      for (const [index, [id, owner]] of expected.entries()) {
        const envelope = delivered[index]!;
        if (owner === unsealable) {
          expect(envelope.credential).toBeUndefined();
          expect(() => openRunnerAccountHome(plantedHome, owner, "codex")).toThrow(
            RunnerAccountHomeError,
          );
          continue;
        }
        expect(envelope.credential?.version).toBe(1);
        const opened = openForRunner(
          readFileSync(key.keyPath, "utf8"),
          envelope.credential!.sealed!,
          agentCredentialContext(id, owner.accountId, 1),
        );
        const token = owner === first ? "first" : "second";
        expect(JSON.parse(opened)).toEqual(files(`{"token":"${token}"}`));
      }
    };

    for (const position of [0, 1, 2]) {
      const owners = [first, second];
      owners.splice(position, 0, unsealable);
      const batch = (path: string) =>
        owners.map((owner, index): [string, RunnerAccount] => [
          `${path}${position}x${index}`,
          owner,
        ]);

      const ordinary = batch("command");
      expectBatch(
        await work.attachCredentials(
          "R",
          ordinary.map(([id, owner]) => sign(loginCheck(id, owner))),
        ),
        ordinary,
      );

      const helped = batch("helper");
      await seed(db, (q) => q.orm.delete(q.t.runnerHelper));
      await seed(
        db,
        ...helped.map(
          ([id, owner]) =>
            (q: Q) =>
              q.orm.insert(q.t.runnerHelper).values({
                id,
                runnerId: "R",
                workspaceId: "acme",
                sessionId: null,
                sessionGeneration: 0,
                runnerFence: 0,
                purpose: "probe_distill",
                envelope: json(db, sign(helper(id, owner))),
                expiresAt: NOW + 60_000,
              }),
        ),
      );
      const delivered = await helperCommands();
      expect(delivered.status).toBe(200);
      expectBatch(delivered.commands!, helped);

      const retried = batch("retro");
      await seed(db, (q) => q.orm.delete(q.t.retroDispatch));
      await seed(
        db,
        ...retried.map(([id, owner], index) => (q: Q) => {
          const command = retro(id, owner, index + 1);
          return q.orm.insert(q.t.retroDispatch).values({
            commandId: id,
            retroId: "retro",
            attempt: index + 1,
            workspaceId: "acme",
            runnerId: "R",
            runnerFence: 0,
            command: json(db, command),
            envelope: json(db, signRetro(command)),
            createdAt: NOW + index,
            issuedAt: NOW,
            expiresAt: NOW + 60_000,
          });
        }),
      );
      expectBatch(await retros.commands("R"), retried);
    }

    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: "routine",
        runnerId: "R",
        kind: "login_check",
        envelope: json(db, sign(loginCheck("routine", unsealable))),
        expiresAt: NOW + 60_000,
      }),
    );
    const polled = (await workHttp(get("/v1/commands"), "R"))!;
    expect(polled.status).toBe(200);
    expectBatch(((await polled.json()) as { commands: SignedRunnerCommand[] }).commands, [
      ["routine", unsealable],
    ]);

    await seed(db, (q) => q.orm.update(q.t.runnerCertificate).set({ acceptedUntil: NOW }));
    expect((await workHttp(get("/v1/commands"), "R"))!.status).toBe(409);
    expect((await helperCommands()).status).toBe(403);
    await expect(retros.commands("R")).rejects.toThrow(RunnerWorkFencedError);
    await seed(db, (q) => q.orm.update(q.t.runnerCertificate).set({ acceptedUntil: NOW * 2 }));

    await seed(db, (q) => q.orm.update(q.t.runner).set({ fence: 1 }));
    expect((await helperCommands()).commands).toEqual([]);
    expect(await retros.commands("R")).toEqual([]);
    await seed(db, (q) => q.orm.update(q.t.runner).set({ fence: 0 }));

    await seed(db, (q) => q.orm.update(q.t.workspaceMember).set({ revokedAt: NOW }));
    expect((await workHttp(get("/v1/commands"), "R"))!.status).toBe(403);
    expect((await helperCommands()).status).toBe(409);
    expect(await retros.commands("R")).toEqual([]);
  }, 30_000);
});
