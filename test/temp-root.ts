import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pt-"));
process.env.TMPDIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
