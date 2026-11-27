import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  copySecretRowsSteps,
  readSecretSteps,
  SecretConflictError,
  secretVersionsSteps,
  writeSecretSteps,
  type Db,
  type SecretRow,
} from "../db";
import { journal, journalCaught } from "../journal";
import {
  isStoredSecretName,
  openSecretAt,
  SECRET_PREFIX,
  sealSecret,
  storedSecrets,
  useSecretTable,
} from "./files";

const MAX_SECRET_BYTES = 1_048_576;
const REFRESH_MS = 10_000;

export async function useDatabaseSecrets(
  store: Db,
  dir: string,
  options: { copy?: boolean; refreshMs?: number } = {},
): Promise<{ close(): Promise<void> }> {
  if (options.copy !== false) {
    const copied = await store.transaction((q) =>
      copySecretRowsSteps(q, secretFiles(dir), Date.now()),
    );
    if (copied > 0)
      journal(`Copied ${copied} secret ${copied === 1 ? "file" : "files"} into the database.`);
  }
  const rows = new Map<string, string>();
  const versions = new Map<string, number>();
  const remember = (name: string, read: { value: string | null; version: number } | null) => {
    if (read === null || read.version < (versions.get(name) ?? 0)) return;
    versions.set(name, read.version);
    if (read.value === null) rows.delete(name);
    else rows.set(name, read.value);
  };
  const reread = async (name: string) =>
    remember(name, await store.run((q) => readSecretSteps(q, name)));
  let refreshing: Promise<void> | null = null;
  const refresh = () =>
    (refreshing ??= (async () => {
      for (const row of await store.run(secretVersionsSteps))
        if (versions.get(row.name) !== row.version) await reread(row.name);
    })().finally(() => {
      refreshing = null;
    }));
  await refresh();
  const put = async (name: string, ciphertext: string | null, exclusive: boolean) => {
    try {
      const expected = versions.get(name) ?? null;
      const version = await store.run((q) => writeSecretSteps(q, name, ciphertext, expected));
      remember(name, { value: ciphertext, version });
    } catch (error) {
      if (!(error instanceof SecretConflictError)) throw error;
      await reread(name);
      if (exclusive) throw new Error("Paws credential file already exists.", { cause: error });
      throw error;
    }
  };
  let writes: Promise<unknown> = Promise.resolve();
  useSecretTable({
    dir,
    rows,
    write(name, ciphertext, exclusive) {
      const written = writes.then(() => put(name, ciphertext, exclusive));
      writes = written.catch(() => undefined);
      return written;
    },
  });
  const timer = setInterval(
    () =>
      void refresh().catch((error: unknown) =>
        journalCaught(error, "credentials.refreshSecrets", null),
      ),
    options.refreshMs ?? REFRESH_MS,
  );
  timer.unref();
  return {
    close: async () => {
      clearInterval(timer);
      useSecretTable(null);
    },
  };
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
