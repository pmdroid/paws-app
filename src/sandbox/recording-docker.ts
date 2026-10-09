import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DockerRecord {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Write an executable named `docker` that appends each invocation's argv and
 * environment as JSON lines. The shebang is absolute, so the scrubbed client
 * environment does not need to contain the interpreter on `PATH`.
 */
export async function writeRecordingDocker(
  directory: string,
): Promise<{ bin: string; record: string }> {
  const bin = join(directory, "docker");
  const record = join(directory, "record.jsonl");
  const source = `#!${process.execPath}
const fs = require("fs");
const env = {};
for (const key of Object.keys(process.env)) env[key] = process.env[key];
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env }) + "\\n");
process.exit(0);
`;
  await writeFile(bin, source, { mode: 0o755 });
  await chmod(bin, 0o755);
  return { bin, record };
}

export async function readDockerRecords(record: string): Promise<DockerRecord[]> {
  const text = await readFile(record, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DockerRecord);
}
