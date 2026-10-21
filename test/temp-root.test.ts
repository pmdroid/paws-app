import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tests commit with the same git identity on every machine", () => {
  const repo = mkdtempSync(join(tmpdir(), "git-identity-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  const ident = Bun.spawnSync(["git", "-C", repo, "var", "GIT_AUTHOR_IDENT"], {
    env: { ...process.env, HOME: repo },
  });
  expect(ident.stdout.toString()).toStartWith("Paws Test <test@paws.invalid>");
});
