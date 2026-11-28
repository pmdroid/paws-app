import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  certificateScratchRoot,
  createRunnerKey,
  initializeRunnerAuthority,
  removeStaleCertificateScratch,
} from "../src/runner-identity";

const TMPFS_MAGIC = 0x01021994;
const tmpfs = (() => {
  try {
    return certificateScratchRoot(["/dev/shm"]);
  } catch {
    return undefined;
  }
})();
const runtimeDir = process.env.XDG_RUNTIME_DIR;
const cleanup: string[] = [];

afterEach(() => {
  if (runtimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = runtimeDir;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function folder(parent: string, prefix: string): string {
  const path = mkdtempSync(join(parent, prefix));
  cleanup.push(path);
  return path;
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name), base)
      : [join(dir, entry.name).slice(base.length + 1)],
  );
}

test("refuses a scratch folder that is not tmpfs", () => {
  const disk = folder(import.meta.dir, ".scratch-disk-");
  const candidates = [undefined, "relative", join(disk, "missing")];
  if (statfsSync(disk).type !== TMPFS_MAGIC) candidates.push(disk);
  expect(() => certificateScratchRoot(candidates)).toThrow(/tmpfs scratch folder/);
});

test.skipIf(!tmpfs)("keeps CA key scratch on tmpfs and out of the secrets folder", async () => {
  const scratch = folder(tmpfs!, "paws-scratch-test-");
  process.env.XDG_RUNTIME_DIR = scratch;
  const root = join(folder(tmpdir(), "paws-certificate-home-"), "secrets", "runner-identity");
  const authority = await initializeRunnerAuthority(root);
  const client = await createRunnerKey(join(root, "..", "client"));
  const issued = await authority.issue(client.csr);
  expect(issued.fingerprint).toMatch(/^[0-9A-F:]+$/);
  expect(files(root).filter((path) => !path.startsWith(".envelope-"))).toEqual([
    "runner-authority.json",
  ]);
  expect(readdirSync(scratch)).toEqual([]);
});

test.skipIf(!tmpfs)("removes certificate scratch older than ten minutes", () => {
  const scratch = folder(tmpfs!, "paws-scratch-test-");
  process.env.XDG_RUNTIME_DIR = scratch;
  const root = folder(tmpdir(), "paws-certificate-root-");
  const old = (Date.now() - 11 * 60_000) / 1000;
  const paths = {
    staleTmpfs: join(scratch, "paws-certificate-stale"),
    freshTmpfs: join(scratch, "paws-certificate-fresh"),
    staleLegacy: join(root, ".certificate-stale"),
    freshLegacy: join(root, ".certificate-fresh"),
    other: join(root, "other-stale"),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "authority.key"), "synthetic-ca-key-marker");
  }
  for (const path of [paths.staleTmpfs, paths.staleLegacy, paths.other]) utimesSync(path, old, old);
  removeStaleCertificateScratch(root);
  expect(existsSync(paths.staleTmpfs)).toBe(false);
  expect(existsSync(paths.staleLegacy)).toBe(false);
  expect(existsSync(paths.freshTmpfs)).toBe(true);
  expect(existsSync(paths.freshLegacy)).toBe(true);
  expect(existsSync(paths.other)).toBe(true);
});
