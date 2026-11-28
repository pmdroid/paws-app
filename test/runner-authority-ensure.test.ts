import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSecret, saveSecret, secretFileExists, useDatabaseSecrets } from "../src/credentials";
import { secretRowsSteps } from "../src/db";
import { ensureRunnerCoordinator } from "../src/runner-coordinator";
import { tempStore } from "./pglite";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function secretsDir() {
  const home = mkdtempSync(join(tmpdir(), "paws-runner-authority-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "secrets");
  mkdirSync(dir, { mode: 0o700 });
  return { dir, root: join(dir, "runner-identity") };
}

function populate(root: string) {
  mkdirSync(join(root, "inputs"), { recursive: true });
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(join(root, "inputs", "input.bin"), "input");
  writeFileSync(join(root, "agent-read-tokens.json"), "{}");
}

test("creates the authority once and reuses it afterwards", async () => {
  const { root } = secretsDir();
  const first = await ensureRunnerCoordinator(root);
  expect(first.created).toBe(true);
  const second = await ensureRunnerCoordinator(root);
  expect(second.created).toBe(false);
  expect(second.signingKeys[0].keyId).toBe(first.signingKeys[0].keyId);
});

test("creates the authority in a folder that already holds inputs, artifacts and read tokens", async () => {
  const { root } = secretsDir();
  populate(root);
  expect((await ensureRunnerCoordinator(root)).created).toBe(true);
  expect(existsSync(join(root, "inputs", "input.bin"))).toBe(true);
  expect(existsSync(join(root, "artifacts"))).toBe(true);
  expect(existsSync(join(root, "agent-read-tokens.json"))).toBe(true);
  expect(existsSync(join(root, "runner-authority.json"))).toBe(true);
});

test("reuses an authority kept in the database secret table", async () => {
  const { dir, root } = secretsDir();
  const { db, close } = await tempStore();
  cleanup.push(close);
  const first = await useDatabaseSecrets(db, dir);
  const created = await ensureRunnerCoordinator(root);
  await first.close();
  expect(created.created).toBe(true);
  expect(existsSync(join(root, "runner-authority.json"))).toBe(false);
  const second = await useDatabaseSecrets(db, dir);
  cleanup.push(() => second.close());
  const reused = await ensureRunnerCoordinator(root);
  expect(reused.created).toBe(false);
  expect(reused.signingKeys[0].keyId).toBe(created.signingKeys[0].keyId);
});

test("copies an authority kept in files and never replaces an uncopied one", async () => {
  const { dir, root } = secretsDir();
  const { db, close } = await tempStore();
  cleanup.push(close);
  const created = await ensureRunnerCoordinator(root);
  const authority = await Bun.file(join(root, "runner-authority.json")).text();
  const signing = await Bun.file(join(root, "runner-command-key.pem")).text();
  const first = await useDatabaseSecrets(db, dir);
  const reused = await ensureRunnerCoordinator(root);
  expect(reused.created).toBe(false);
  expect(reused.signingKeys[0].keyId).toBe(created.signingKeys[0].keyId);
  const row = (await db.run(secretRowsSteps)).find((r) => r.name.endsWith("authority.json"));
  expect(row?.ciphertext).toBe(authority);
  expect(existsSync(join(root, "runner-authority.json"))).toBe(false);
  for (const name of ["runner-authority.json", "runner-command-key.pem"])
    await removeSecret(join(root, name));
  await first.close();
  await Bun.write(join(root, "runner-authority.json"), authority);
  await Bun.write(join(root, "runner-command-key.pem"), signing);
  const second = await useDatabaseSecrets(db, dir);
  cleanup.push(() => second.close());
  await expect(ensureRunnerCoordinator(root)).rejects.toThrow("will not replace them");
});

test("refuses a partial identity and writes nothing", async () => {
  const { root } = secretsDir();
  populate(root);
  await saveSecret(join(root, "runner-command-key.pem"), "key");
  const before = readdirSync(root, { recursive: true }).sort();
  await expect(ensureRunnerCoordinator(root)).rejects.toThrow(
    "Runner identity is incomplete: runner-authority.json is missing. Restore it from backup.",
  );
  expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
});

test("a failure after the authority is written removes only what this call wrote", async () => {
  const { root } = secretsDir();
  populate(root);
  await expect(
    ensureRunnerCoordinator(root, () => {
      throw new Error("injected");
    }),
  ).rejects.toThrow("injected");
  expect(secretFileExists(join(root, "runner-authority.json"))).toBe(false);
  expect(secretFileExists(join(root, "runner-command-key.pem"))).toBe(false);
  expect(existsSync(join(root, "inputs", "input.bin"))).toBe(true);
  expect(existsSync(join(root, "agent-read-tokens.json"))).toBe(true);
  expect((await ensureRunnerCoordinator(root)).created).toBe(true);
});
