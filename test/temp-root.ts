import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", "pt-"));
process.env.TMPDIR = root;
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = Paws Test\n\temail = test@paws.invalid\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
// Task runners may supply an App bot identity. Disposable test repositories use this fixture.
for (const role of ["AUTHOR", "COMMITTER"]) {
  process.env[`GIT_${role}_NAME`] = "Paws Test";
  process.env[`GIT_${role}_EMAIL`] = "test@paws.invalid";
}
afterAll(() => rmSync(root, { recursive: true, force: true }));
