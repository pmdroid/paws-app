import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGitHubAppCredentials } from "../src/config";
import {
  readSecretFile,
  removeSecret,
  saveSecret,
  storeSecretKeys,
  useDatabaseSecrets,
  writeSecretFile,
} from "../src/credentials";
import { secretRowsSteps, type Db } from "../src/db";
import { realProbe } from "../src/doctor";
import { configureRunnerTranscriptStorage } from "../src/runner-transcript-config";
import { setJournalSink } from "../src/journal";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  for (const handle of open.splice(0)) await handle.close();
});

async function setup(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  const home = mkdtempSync(join(tmpdir(), "paws-secret-store-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return { db: handle.db, home, dir: join(home, "secrets") };
}

async function install(db: Db, dir: string) {
  const secrets = await useDatabaseSecrets(db, dir);
  cleanup.push(() => secrets.close());
  return secrets;
}

function withSecretKey(value: string) {
  const previous = process.env.PAWS_SECRET_KEY;
  process.env.PAWS_SECRET_KEY = value;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PAWS_SECRET_KEY;
    else process.env.PAWS_SECRET_KEY = previous;
  });
}

test("with PAWS_SECRET_KEY and no .envelope-key file runner storage can be configured again", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-secret-store-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  withSecretKey(randomBytes(32).toString("base64"));
  configureRunnerTranscriptStorage(home, '{"kind":"local"}');
  configureRunnerTranscriptStorage(home, '{"kind":"local"}');
  expect(existsSync(join(home, "secrets", ".envelope-key"))).toBe(false);
  expect(readSecretFile(join(home, "secrets", "runner-transcript-storage.json"))).toBe(
    '{"kind":"local"}',
  );
});

test("doctor reports undecryptable secret files before it loads the runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-secret-store-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  withSecretKey(randomBytes(32).toString("base64"));
  writeSecretFile(join(home, "secrets", "github-webhook"), "whsec");
  withSecretKey(randomBytes(32).toString("base64"));
  await expect(realProbe({ PAWS_HOME: home })).rejects.toThrow(
    `missing secrets: PAWS_SECRET_KEY does not decrypt github-webhook in files in ${join(home, "secrets")}`,
  );
});

forEachDialect((connect) => {
  test("a write or delete the database refuses rejects and leaves the stored value", async () => {
    const { db, dir } = await setup(connect);
    const path = join(dir, "linear-webhook");
    await install(db, dir);
    await saveSecret(path, "kept");
    let down = false;
    const flaky: Db = {
      ...db,
      run: (body) => (down ? Promise.reject(new Error("database down")) : db.run(body)),
    } as Db;
    await install(flaky, dir);
    expect(() => writeSecretFile(path, "sync")).toThrow("write it with saveSecret");
    down = true;
    await expect(saveSecret(path, "lost")).rejects.toThrow("database down");
    expect(readSecretFile(path)).toBe("kept");
    await expect(removeSecret(path)).rejects.toThrow("database down");
    expect(readSecretFile(path)).toBe("kept");
    await expect(storeSecretKeys([join(dir, "runner-file.key")])).rejects.toThrow("database down");
    expect(readSecretFile(join(dir, "runner-file.key"))).toBeNull();
    down = false;
    await install(db, dir);
    expect(readSecretFile(path)).toBe("kept");
    await storeSecretKeys([join(dir, "runner-file.key")]);
    expect((await db.run(secretRowsSteps)).map((row) => row.name).sort()).toEqual([
      "linear-webhook",
      "runner-file.key",
    ]);
  });

  test("a secret written through the store reads back and the table holds ciphertext only", async () => {
    const { db, dir } = await setup(connect);
    const secrets = await install(db, dir);
    const path = join(dir, "github-webhook");
    expect(await saveSecret(path, "whsec-plaintext")).toBe(true);
    expect(await saveSecret(path, "whsec-plaintext")).toBe(false);
    expect(readSecretFile(path)).toBe("whsec-plaintext");
    expect(existsSync(path)).toBe(false);
    await secrets.close();
    const rows = await db.run(secretRowsSteps);
    expect(rows.map((row) => row.name)).toEqual(["github-webhook"]);
    expect(rows[0]!.ciphertext.startsWith("paws-envelope-v1\n")).toBe(true);
    expect(rows[0]!.ciphertext).not.toContain("whsec-plaintext");

    const reopened = await install(db, dir);
    expect(readSecretFile(path)).toBe("whsec-plaintext");
    await removeSecret(path);
    expect(readSecretFile(path)).toBeNull();
    await reopened.close();
    expect(await db.run(secretRowsSteps)).toEqual([]);
  });

  test("with PAWS_SECRET_KEY and no .envelope-key file the control plane reads its secrets", async () => {
    const { db, home, dir } = await setup(connect);
    withSecretKey(randomBytes(32).toString("base64"));
    await install(db, dir);
    await saveSecret(join(dir, "github-app.pem"), "-----BEGIN PRIVATE KEY-----");
    await saveSecret(
      join(dir, "github-app.json"),
      JSON.stringify({
        appId: "1",
        clientId: "client",
        clientSecret: "secret",
        privateKeyPath: join(dir, "github-app.pem"),
      }),
    );
    expect(existsSync(join(dir, ".envelope-key"))).toBe(false);
    const app = loadGitHubAppCredentials(home, {});
    expect(app?.appId).toBe("1");
    expect(readSecretFile(app!.privateKeyPath, false)).toBe("-----BEGIN PRIVATE KEY-----");
    withSecretKey(randomBytes(32).toString("base64"));
    expect(() => readSecretFile(join(dir, "github-app.pem"), false)).toThrow(
      "Could not decrypt Paws credentials",
    );
  });

  test("the import copies each file secret that has no row yet, once", async () => {
    const { db, dir } = await setup(connect);
    writeSecretFile(join(dir, "linear-webhook"), "linear-secret");
    mkdirSync(join(dir, "runner-identity"), { mode: 0o700 });
    writeSecretFile(join(dir, "runner-identity", "agent-read-tokens.json"), "[]");
    const fileCiphertext = readFileSync(join(dir, "linear-webhook"), "utf8");
    const lines: string[] = [];
    cleanup.push(setJournalSink((line) => lines.push(line)));

    const first = await install(db, dir);
    expect(lines).toContain("Copied 2 secret files into the database.");
    expect(readSecretFile(join(dir, "linear-webhook"))).toBe("linear-secret");
    expect(readSecretFile(join(dir, "runner-identity", "agent-read-tokens.json"))).toBe("[]");
    await saveSecret(join(dir, "linear-webhook"), "rotated");
    await first.close();
    const rows = await db.run(secretRowsSteps);
    expect(
      rows.find((row) => row.name === "runner-identity/agent-read-tokens.json")?.ciphertext,
    ).toBe(readFileSync(join(dir, "runner-identity", "agent-read-tokens.json"), "utf8"));
    expect(existsSync(join(dir, "linear-webhook"))).toBe(true);
    expect(readFileSync(join(dir, "linear-webhook"), "utf8")).toBe(fileCiphertext);

    lines.length = 0;
    await install(db, dir);
    expect(lines).toEqual([]);
    expect(readSecretFile(join(dir, "linear-webhook"))).toBe("rotated");
    await first.close();

    writeSecretFile(join(dir, "tailscale-authkey"), "tskey");
    await install(db, dir);
    expect(lines).toEqual(["Copied 1 secret file into the database."]);
    expect(readSecretFile(join(dir, "tailscale-authkey"))).toBe("tskey");
    expect((await db.run(secretRowsSteps)).length).toBe(3);

    await removeSecret(join(dir, "tailscale-authkey"));
    lines.length = 0;
    await install(db, dir);
    expect(lines).toEqual([]);
    expect(existsSync(join(dir, "tailscale-authkey"))).toBe(true);
    expect(readSecretFile(join(dir, "tailscale-authkey"))).toBeNull();
    await saveSecret(join(dir, "tailscale-authkey"), "tskey-2", true);
    expect(readSecretFile(join(dir, "tailscale-authkey"))).toBe("tskey-2");
    await expect(saveSecret(join(dir, "tailscale-authkey"), "again", true)).rejects.toThrow(
      "already exists",
    );
  });
});
