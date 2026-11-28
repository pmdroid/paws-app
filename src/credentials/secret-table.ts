import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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
  isTableSecretFile,
  openSecretAt,
  SECRET_PREFIX,
  sealSecret,
  storedSecrets,
  useSecretTable,
} from "./files";
import { isOwnedSecretName, isPrunedSecretFolder } from "./names";

const MAX_SECRET_BYTES = 1_048_576;
const REFRESH_MS = 10_000;
const unowned = new Set<string>();

export async function useDatabaseSecrets(
  store: Db,
  dir: string,
  options: { files?: readonly string[]; refreshMs?: number } = {},
): Promise<{ close(): Promise<void> }> {
  const kept = new Set(options.files);
  const copy = secretFiles(dir).filter((row) => !kept.has(row.name));
  const copied = await store.transaction((q) => copySecretRowsSteps(q, copy, Date.now()));
  if (copied > 0)
    journal(`Copied ${copied} secret ${copied === 1 ? "file" : "files"} into the database.`);
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
    files: kept,
    write(name, ciphertext, exclusive) {
      const written = writes.then(() => put(name, ciphertext, exclusive));
      writes = written.catch(() => undefined);
      return written;
    },
  });
  retireSecretFiles(dir, rows);
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

function ownedSecretFiles(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  const skipped = new Set(
    [
      "PAWS_TLS_KEY_PATH",
      "PAWS_TLS_CERT_PATH",
      "PAWS_RUNNER_TLS_KEY_PATH",
      "PAWS_RUNNER_TLS_CERT_PATH",
    ]
      .map((name) => process.env[name]?.trim())
      .filter((path): path is string => !!path)
      .map((path) => resolve(path)),
  );
  const walk = (folder: string): { name: string; path: string }[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name);
      const name = relative(dir, path);
      if (skipped.has(resolve(path))) return [];
      if (entry.isDirectory()) return isPrunedSecretFolder(name) ? [] : walk(path);
      if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith(".tmp")) return [];
      if (!isOwnedSecretName(name)) {
        if (!unowned.has(resolve(path))) journal(`not imported: ${name}`);
        unowned.add(resolve(path));
        return [];
      }
      if (statSync(path).size > MAX_SECRET_BYTES) return [];
      return [{ name, path }];
    });
  return walk(dir);
}

export function secretFiles(dir: string): SecretRow[] {
  return ownedSecretFiles(dir).map(({ name, path }) => {
    const text = readFileSync(path, "utf8");
    const ciphertext = text.startsWith(SECRET_PREFIX)
      ? text
      : sealSecret(dirname(path), basename(path), text);
    return { name, ciphertext };
  });
}

function retireSecretFiles(dir: string, rows: ReadonlyMap<string, string>): void {
  const folder = join(dir, `.retired-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`);
  let moved = 0;
  for (const { name, path } of ownedSecretFiles(dir)) {
    if (!isTableSecretFile(path)) continue;
    try {
      const row = rows.get(name);
      if (row === undefined) {
        journal(`secret file kept, no row in the secret table: ${name}`);
        continue;
      }
      const text = readFileSync(path, "utf8");
      const value = text.startsWith(SECRET_PREFIX) ? openSecretAt(path, text) : text;
      if (value !== openSecretAt(path, row)) {
        journal(`secret file kept, it differs from the secret table: ${name}`);
        continue;
      }
      const target = join(folder, name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      chmodSync(folder, 0o700);
      chmodSync(dirname(target), 0o700);
      renameSync(path, target);
      moved += 1;
    } catch (error) {
      journalCaught(error, "credentials.retireSecretFiles", null, `secret file kept: ${name}`);
    }
  }
  if (moved > 0)
    journal(
      `Moved ${moved} secret ${moved === 1 ? "file" : "files"} held in the database to ${relative(dir, folder)}.`,
    );
}

export function secretFilesOnDisk(dir: string): { kept: number; retired: string[] } {
  if (storedSecrets() === null || !existsSync(dir)) return { kept: 0, retired: [] };
  return {
    kept: ownedSecretFiles(dir).filter(({ path }) => isTableSecretFile(path)).length,
    retired: readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".retired-"))
      .map((entry) => entry.name)
      .sort(),
  };
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
