import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  copySecretRowsSteps,
  secretRowsSteps,
  writeSecretRowSteps,
  type Db,
  type SecretRow,
} from "../db";
import { journal } from "../journal";
import {
  isStoredSecretName,
  openSecretAt,
  SECRET_PREFIX,
  sealSecret,
  storedSecrets,
  useSecretTable,
} from "./files";

const MAX_SECRET_BYTES = 1_048_576;

export async function useDatabaseSecrets(
  store: Db,
  dir: string,
  options: { copy?: boolean } = {},
): Promise<{ close(): Promise<void> }> {
  if (options.copy !== false) {
    const copied = await store.transaction((q) =>
      copySecretRowsSteps(q, secretFiles(dir), Date.now()),
    );
    if (copied > 0)
      journal(`Copied ${copied} secret ${copied === 1 ? "file" : "files"} into the database.`);
  }
  const rows = await store.run(secretRowsSteps);
  const cached = new Map(rows.map((row) => [row.name, row.ciphertext]));
  useSecretTable({
    dir,
    rows: cached,
    async write(name, ciphertext, exclusive) {
      const written = await store.run((q) =>
        writeSecretRowSteps(q, { name, ciphertext, now: Date.now(), exclusive }),
      );
      if (written) return;
      const winner = (await store.run(secretRowsSteps)).find((row) => row.name === name);
      if (winner) cached.set(name, winner.ciphertext);
      throw new Error("Paws credential file already exists.");
    },
  });
  return { close: async () => useSecretTable(null) };
}

export function secretFiles(dir: string): SecretRow[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith(".tmp")) return [];
    if (!isStoredSecretName(relative(dir, path)) || statSync(path).size > MAX_SECRET_BYTES)
      return [];
    const text = readFileSync(path, "utf8");
    const ciphertext = text.startsWith(SECRET_PREFIX)
      ? text
      : sealSecret(entry.parentPath, entry.name, text);
    return [{ name: relative(dir, path), ciphertext }];
  });
}

export function checkSecrets(dir: string) {
  const stored = storedSecrets();
  const rows = stored ?? secretFiles(dir);
  const failed = rows.filter((row) => {
    try {
      openSecretAt(join(dir, row.name), row.ciphertext);
      return false;
    } catch {
      return true;
    }
  });
  const where = stored === null ? `files in ${dir}` : "the database secret table";
  return { where, count: rows.length, failed: failed.map((row) => row.name) };
}
