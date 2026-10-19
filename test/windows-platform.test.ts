import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterBinPath } from "../src/acp";
import {
  directorySyncSupported,
  privateKeyModeIsPrivate,
  readSecretFile,
  secretModeIsPrivate,
  writeSecretFile,
} from "../src/credentials";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("directory fsync is skipped only where Windows cannot open a directory", () => {
  expect(directorySyncSupported("win32")).toBe(false);
  expect(directorySyncSupported("linux")).toBe(true);
  expect(directorySyncSupported("darwin")).toBe(true);
});

test("a secret file is private by mode on POSIX and not mode-checked on Windows", () => {
  expect(secretModeIsPrivate(0o100600, "linux")).toBe(true);
  expect(secretModeIsPrivate(0o100644, "linux")).toBe(false);
  expect(secretModeIsPrivate(0o100640, "darwin")).toBe(false);
  expect(secretModeIsPrivate(0o100666, "win32")).toBe(true);
});

test("a GitHub App key may be 0600 or 0400 on POSIX and is not mode-checked on Windows", () => {
  expect(privateKeyModeIsPrivate(0o100600, "linux")).toBe(true);
  expect(privateKeyModeIsPrivate(0o100400, "darwin")).toBe(true);
  expect(privateKeyModeIsPrivate(0o100644, "linux")).toBe(false);
  expect(privateKeyModeIsPrivate(0o100666, "win32")).toBe(true);
  expect(privateKeyModeIsPrivate(0o100444, "win32")).toBe(true);
});

test("adapter bins resolve to the .exe link on Windows and the bare name elsewhere", () => {
  const root = join("some", "checkout");
  const windows = adapterBinPath("implementer", root, "win32");
  expect(windows).toBe(join(root, "node_modules", ".bin", "claude-agent-acp.exe"));
  expect(adapterBinPath("reviewer", root, "win32")).toBe(
    join(root, "node_modules", ".bin", "codex-acp.exe"),
  );
  expect(adapterBinPath("implementer", root, "linux")).toBe(
    join(root, "node_modules", ".bin", "claude-agent-acp"),
  );
  expect(adapterBinPath("reviewer", root, "darwin")).toBe(
    join(root, "node_modules", ".bin", "codex-acp"),
  );
});

test("a credential round-trips on this platform without a failing directory fsync", () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-platform-test-"));
  directories.push(dir);
  const path = join(dir, "linear-api-key");
  expect(writeSecretFile(path, "synthetic-value")).toBe(true);
  expect(readFileSync(path, "utf8")).not.toContain("synthetic");
  expect(readSecretFile(path)).toBe("synthetic-value");
  expect(writeSecretFile(path, "synthetic-value")).toBe(false);
});
