import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  closeoutBinPath,
  closeoutPlatform,
  installCloseout,
  loadCloseoutManifest,
} from "../install";
import type { SetupFetch, SetupIO } from "./io";
import { stop, SetupStopped } from "./stop";

const UNRELEASED =
  "pmdroid/closeout has no published release assets yet. Re-run with --closeout-path set to a local closeout binary.";

/** Starter `.agents/closeout.yaml`. A file that already exists is left alone. */
export const CLOSEOUT_STARTER = `specVersion: "0.1"
description: Starter Closeout policy written by paws setup. Replace these commands with the checks this repository should pass before a pull request.
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
setup:
  - id: install
    exec: ["bun", "install", "--frozen-lockfile"]
    timeoutSeconds: 600
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 120
`;

/**
 * Install Closeout into `~/.paws/bin/closeout`.
 * The pinned manifest has no GitHub release assets yet, so a download fails
 * with one line unless `--closeout-path` points at a local binary.
 */
export async function installCloseoutBinary(input: {
  home: string;
  closeoutPath: string | null;
  cwd: string;
  fetch?: SetupFetch;
}): Promise<string> {
  const dest = closeoutBinPath(input.home);
  if (input.closeoutPath !== null) {
    const source = resolve(input.cwd, input.closeoutPath);
    if (!existsSync(source) || !statSync(source).isFile()) {
      stop(`--closeout-path is not a file (${source}). Pass a local closeout binary.`);
    }
    copyExecutable(source, dest);
    return dest;
  }
  let digestKind: string;
  try {
    const manifest = loadCloseoutManifest();
    const platform = closeoutPlatform();
    digestKind = manifest.assets[platform].digestKind;
  } catch (error) {
    if (error instanceof SetupStopped) throw error;
    const message =
      error instanceof Error ? error.message : "Could not read the closeout manifest.";
    stop(message);
  }
  if (digestKind === "unreleased-placeholder") stop(UNRELEASED);
  try {
    await installCloseout({
      home: input.home,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
  } catch (error) {
    if (error instanceof SetupStopped) throw error;
    const message = error instanceof Error ? error.message : "Closeout install failed.";
    stop(message);
  }
  return dest;
}

export async function ensureCloseoutPolicy(input: {
  checkout: string;
  yes: boolean;
  io: SetupIO;
}): Promise<void> {
  const path = join(input.checkout, ".agents", "closeout.yaml");
  if (existsSync(path)) return;
  const offer = `Write a starter .agents/closeout.yaml in ${input.checkout}?`;
  if (!input.yes) {
    input.io.stdout(`${offer} [y/N]`);
    const answer = (await input.io.readLine())?.trim().toLowerCase() ?? "";
    if (answer !== "y" && answer !== "yes") {
      stop(`Create .agents/closeout.yaml in ${input.checkout} before running Paws.`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CLOSEOUT_STARTER, { mode: 0o644 });
}

function copyExecutable(source: string, dest: string): void {
  if (resolve(source) === resolve(dest)) {
    if ((statSync(dest).mode & 0o111) === 0) chmodSync(dest, 0o755);
    return;
  }
  const bytes = readFileSync(source);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  if (existsSync(dest)) {
    const current = readFileSync(dest);
    const executable = (statSync(dest).mode & 0o111) !== 0;
    if (current.equals(bytes) && executable) return;
  }
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  chmodSync(dest, 0o755);
}
