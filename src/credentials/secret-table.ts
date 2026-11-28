import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
const RETIRED_KEEP_MS = 86_400_000;
const START_MARKER = ".last-start";
const keptRetired = new Map<string, string>();

export async function useDatabaseSecrets(
  store: Db,
  dir: string,
  options: { files?: readonly string[]; refreshMs?: number; deleteRetired?: { now: number } } = {},
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
  if (options.deleteRetired && existsSync(dir))
    try {
      deleteRetiredFolders(dir, rows, options.deleteRetired.now);
    } catch (error) {
      journalCaught(error, "credentials.deleteRetiredFolders", null);
    }
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
  const stamp = `.retired-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`;
  let folder: string | null = null;
  const retiredFolder = (): string => {
    for (let n = 0; folder === null; n += 1) {
      const path = join(dir, n === 0 ? stamp : `${stamp}-${n}`);
      try {
        mkdirSync(path, { mode: 0o700 });
        chmodSync(path, 0o700);
        folder = path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return folder;
  };
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
      const target = join(retiredFolder(), name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      chmodSync(dirname(target), 0o700);
      renameSync(path, target);
      moved += 1;
    } catch (error) {
      journalCaught(error, "credentials.retireSecretFiles", null, `secret file kept: ${name}`);
    }
  }
  if (moved > 0 && folder !== null)
    journal(
      `Moved ${moved} secret ${moved === 1 ? "file" : "files"} held in the database to ${relative(dir, folder)}.`,
    );
}

function deleteRetiredFolders(dir: string, rows: ReadonlyMap<string, string>, now: number): void {
  const marker = join(dir, START_MARKER);
  const previous = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  writeFileSync(marker, "started\n", { mode: 0o600 });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".retired-")) continue;
    const folder = join(dir, entry.name);
    const names = readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((file) => !file.isDirectory())
      .map((file) => relative(folder, join(file.parentPath, file.name)));
    const undecrypted = names.filter((name) => {
      const row = rows.get(name);
      if (row === undefined) return true;
      try {
        openSecretAt(join(dir, name), row);
        return false;
      } catch {
        return true;
      }
    });
    const at = retiredAt(entry.name);
    const reason =
      undecrypted.length > 0
        ? `kept, ${undecrypted.length} of its files did not decrypt from the secret table`
        : at === null || now - at < RETIRED_KEEP_MS
          ? "kept until it is 24 hours old"
          : previous !== "completed"
            ? "kept, the previous start did not complete"
            : null;
    if (reason !== null) {
      keptRetired.set(folder, reason);
      continue;
    }
    rmSync(folder, { recursive: true });
    keptRetired.delete(folder);
    journal(
      `Deleted ${entry.name} with ${names.length} secret ${names.length === 1 ? "file" : "files"} held in the database.`,
    );
  }
}

function retiredAt(name: string): number | null {
  const stamp = /^\.retired-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z(?:-\d+)?$/.exec(name);
  if (stamp === null) return null;
  const [, y, mo, d, h, mi, s] = stamp;
  const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(at) ? null : at;
}

export function completeSecretStart(dir: string): void {
  const marker = join(dir, START_MARKER);
  if (existsSync(marker)) writeFileSync(marker, "completed\n", { mode: 0o600 });
}

export function secretFilesOnDisk(dir: string): { kept: number; retired: string[] } {
  if (storedSecrets() === null || !existsSync(dir)) return { kept: 0, retired: [] };
  return {
    kept: ownedSecretFiles(dir).filter(({ path }) => isTableSecretFile(path)).length,
    retired: readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".retired-"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => {
        const reason = keptRetired.get(join(dir, name));
        return reason === undefined ? name : `${name} (${reason})`;
      }),
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
