import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/** The `KEY=value` file the Paws user service reads. Mode 0600. */
export type EnvFile = {
  path: string;
  get(key: string): string | null;
  /** Set or replace one key and write the file. Other lines are kept. */
  set(key: string, value: string): void;
  values(): Record<string, string>;
};

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function openEnvFile(path: string): EnvFile {
  let lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  return {
    path,
    get(key) {
      return this.values()[key] ?? null;
    },
    set(key, value) {
      if (/[\r\n]/.test(value)) throw new Error(`${key} must be one line.`);
      const line = `${key}=${value}`;
      const index = lines.findIndex((text) => LINE.exec(text)?.[1] === key);
      lines = index === -1 ? [...lines, line] : lines.with(index, line);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    },
    values() {
      const values: Record<string, string> = {};
      for (const text of lines) {
        const match = LINE.exec(text);
        if (match) values[match[1]!] = unquote(match[2]!.trim());
      }
      return values;
    },
  };
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}
