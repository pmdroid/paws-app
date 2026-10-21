import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", "pt-"));
process.env.TMPDIR = root;
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = Paws Test\n\temail = test@paws.invalid\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
afterAll(() => rmSync(root, { recursive: true, force: true }));
