import { afterAll } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.PAWS_TEST_PROGRESS_DIR;

if (directory) {
  const marker = join(directory, String(process.pid));
  writeFileSync(marker, `${Date.now()} ${Bun.main}\n`);
  afterAll(() => rmSync(marker, { force: true }));
}
