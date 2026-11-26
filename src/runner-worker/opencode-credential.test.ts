import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { returnRunnerAgentCredentials } from "../runner-execution";
import type { RunnerAgentCredentialFiles } from "../runner-protocol";
import {
  OPENCODE_CREDENTIAL_FILE,
  OPENCODE_DATABASE,
  collectOpenCodeCredential,
  placeOpenCodeCredential,
} from "./opencode-credential";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const credential = JSON.stringify({
  type: "oauth",
  methodID: "device",
  refresh: "refresh-1",
  access: "access-1",
  expires: 1_900_000_000_000,
});

function home(file: string | null = credential): string {
  const root = mkdtempSync(join(tmpdir(), "paws-opencode-credential-"));
  roots.push(root);
  if (file !== null) {
    mkdirSync(dirname(join(root, OPENCODE_CREDENTIAL_FILE)), { recursive: true });
    writeFileSync(join(root, OPENCODE_CREDENTIAL_FILE), file);
  }
  return root;
}

function migrate(root: string, calls: string[] = []) {
  return async () => {
    calls.push(root);
    mkdirSync(dirname(join(root, OPENCODE_DATABASE)), { recursive: true });
    const db = new Database(join(root, OPENCODE_DATABASE));
    db.run("CREATE TABLE `session` (`id` text PRIMARY KEY)");
    db.run(`CREATE TABLE \`credential\` (
      \`id\` text PRIMARY KEY,
      \`integration_id\` text,
      \`label\` text NOT NULL,
      \`value\` text NOT NULL,
      \`connector_id\` text,
      \`method_id\` text,
      \`active\` integer,
      \`time_created\` integer NOT NULL,
      \`time_updated\` integer NOT NULL
    )`);
    db.close();
  };
}

function rows(root: string) {
  const db = new Database(join(root, OPENCODE_DATABASE), { readonly: true });
  try {
    return db
      .query<
        { id: string; integration_id: string; label: string; value: string; active: number },
        []
      >("SELECT id, integration_id, label, value, active FROM credential ORDER BY id")
      .all();
  } finally {
    db.close();
  }
}

function insert(root: string, id: string, integration: string, value: string) {
  const db = new Database(join(root, OPENCODE_DATABASE));
  db.run(
    "INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, 'OAuth', ?, 1, 1)",
    [id, integration, value],
  );
  db.close();
}

function refresh(root: string, value: string) {
  const db = new Database(join(root, OPENCODE_DATABASE));
  db.run("UPDATE credential SET value = ? WHERE integration_id = 'opencode'", [value]);
  db.close();
}

function returned(root: string): RunnerAgentCredentialFiles {
  let files: RunnerAgentCredentialFiles = [];
  returnRunnerAgentCredentials(root, "opencode", "01JEXECUTION00000000000000", (read) => {
    files = read;
  });
  return files;
}

test("creates the database through the CLI and upserts the credential before a turn", async () => {
  const root = home();
  const calls: string[] = [];
  expect(await placeOpenCodeCredential(root, "opencode", migrate(root, calls))).toBe(credential);
  expect(calls).toEqual([root]);
  const [row] = rows(root);
  expect(rows(root)).toHaveLength(1);
  expect(row).toMatchObject({ integration_id: "opencode", label: "OAuth", value: credential });
  expect(row?.active).toBe(1);
  expect(row?.id.startsWith("cred_")).toBe(true);
});

test("replaces an existing OpenCode row and leaves other integrations alone", async () => {
  const root = home();
  await migrate(root)();
  insert(root, "cred_old", "opencode", '{"type":"oauth","access":"stale"}');
  insert(root, "cred_older", "opencode", '{"type":"oauth","access":"older"}');
  insert(root, "cred_xai", "xai", '{"type":"key","key":"k"}');
  const calls: string[] = [];
  await placeOpenCodeCredential(root, "opencode", migrate(root, calls));
  expect(calls).toEqual([]);
  const opencode = rows(root).filter((row) => row.integration_id === "opencode");
  expect(opencode).toHaveLength(1);
  expect(opencode[0]?.value).toBe(credential);
  expect(rows(root).find((row) => row.integration_id === "xai")?.value).toBe(
    '{"type":"key","key":"k"}',
  );
});

test("uploads a row the CLI refreshed during the turn", async () => {
  const root = home();
  const placed = await placeOpenCodeCredential(root, "opencode", migrate(root));
  const refreshed = JSON.stringify({ ...JSON.parse(credential), access: "access-2" });
  refresh(root, refreshed);
  expect(collectOpenCodeCredential(root, placed!)).toBe(true);
  const file = returned(root).find((entry) => entry.path === OPENCODE_CREDENTIAL_FILE);
  expect(Buffer.from(file!.data, "base64").toString("utf8")).toBe(refreshed);
});

test("keeps the delivered credential when the row did not change", async () => {
  const root = home();
  const placed = await placeOpenCodeCredential(root, "opencode", migrate(root));
  expect(collectOpenCodeCredential(root, placed!)).toBe(false);
  expect(readFileSync(join(root, OPENCODE_CREDENTIAL_FILE), "utf8")).toBe(credential);
  const file = returned(root).find((entry) => entry.path === OPENCODE_CREDENTIAL_FILE);
  expect(Buffer.from(file!.data, "base64").toString("utf8")).toBe(credential);
});

test("writes nothing for other agents or without a delivered credential", async () => {
  for (const agent of ["claude", "codex", "grok"] as const) {
    const root = home();
    const calls: string[] = [];
    expect(await placeOpenCodeCredential(root, agent, migrate(root, calls))).toBeNull();
    expect(calls).toEqual([]);
    expect(existsSync(join(root, OPENCODE_DATABASE))).toBe(false);
  }
  const root = home(null);
  expect(await placeOpenCodeCredential(root, "opencode", migrate(root))).toBeNull();
  expect(existsSync(join(root, OPENCODE_DATABASE))).toBe(false);
});

test("stops when the CLI does not create its database", async () => {
  const root = home();
  await expect(placeOpenCodeCredential(root, "opencode", async () => {})).rejects.toThrow(
    "OpenCode did not create its database",
  );
});
