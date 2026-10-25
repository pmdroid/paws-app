import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSecretFile, writeSecretFile } from "../src/credentials";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "paws-envelope-test-"));
  directories.push(path);
  return path;
}

test("each credential has a data key and plaintext never reaches its file", () => {
  const dir = directory();
  const path = join(dir, "linear-oauth.json");
  const value = JSON.stringify({
    accessToken: "synthetic-linear-access",
    refreshToken: "synthetic-refresh",
  });
  expect(writeSecretFile(path, value)).toBe(true);
  const bytes = readFileSync(path, "utf8");
  expect(bytes).not.toContain("synthetic");
  expect(readSecretFile(path)).toBe(value);
  expect(writeSecretFile(path, value)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(bytes);
  const other = join(dir, "slack-oauth.json");
  writeSecretFile(other, value);
  expect(readFileSync(other, "utf8")).not.toBe(bytes);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const file of [path, other, join(dir, ".envelope-key")]) {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});

test("legacy credentials migrate atomically and missing keys and tampering fail closed", () => {
  const dir = directory();
  const path = join(dir, "linear-oauth.json");
  writeFileSync(path, "synthetic-legacy-credential");
  expect(readSecretFile(path)).toBe("synthetic-legacy-credential");
  const original = readFileSync(path, "utf8");
  expect(original).not.toContain("synthetic-legacy-credential");
  const key = join(dir, ".envelope-key");
  renameSync(key, `${key}.saved`);
  expect(() => readSecretFile(path)).toThrow("Could not decrypt Paws credentials");
  expect(readFileSync(path, "utf8")).toBe(original);
  renameSync(`${key}.saved`, key);
  const copied = join(dir, "different-credential.json");
  writeFileSync(copied, original);
  expect(() => readSecretFile(copied)).toThrow("Could not decrypt Paws credentials");
  const envelope = JSON.parse(original.split("\n")[1]!);
  const data = Buffer.from(envelope.value, "base64");
  data[data.length - 1] = data[data.length - 1]! ^ 1;
  envelope.value = data.toString("base64");
  writeFileSync(path, `paws-envelope-v1\n${JSON.stringify(envelope)}`);
  expect(() => readSecretFile(path)).toThrow("Could not decrypt Paws credentials");
});
