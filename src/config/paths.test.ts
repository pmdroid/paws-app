import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, pawsPaths, sweepTmpDir } from "./paths";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("the layout creates tmpDir with mode 0700", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-home-"));
  homes.push(home);
  const paths = pawsPaths(home);
  ensureLayout(paths);
  expect(paths.tmpDir).toBe(join(home, "tmp"));
  expect(statSync(paths.tmpDir).mode & 0o777).toBe(0o700);
});

test("the startup sweep removes only tmp entries older than 24 hours", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-home-"));
  homes.push(home);
  const paths = pawsPaths(home);
  ensureLayout(paths);
  const now = Date.now();
  const age = (name: string, hours: number) => {
    const seconds = (now - hours * 60 * 60 * 1000) / 1000;
    utimesSync(join(paths.tmpDir, name), seconds, seconds);
  };
  mkdirSync(join(paths.tmpDir, "paws-git-old"));
  writeFileSync(join(paths.tmpDir, "paws-git-old", "token"), "acme");
  age("paws-git-old", 25);
  mkdirSync(join(paths.tmpDir, "paws-publication-recent"));
  age("paws-publication-recent", 23);
  writeFileSync(join(paths.tmpDir, "stale-file"), "");
  age("stale-file", 48);
  sweepTmpDir(paths, now);
  expect(readdirSync(paths.tmpDir)).toEqual(["paws-publication-recent"]);
});
