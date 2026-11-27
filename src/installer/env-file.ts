import { existsSync, readFileSync } from "node:fs";

/** The `KEY=value` file the Paws user service reads. Mode 0600. */
export type EnvFile = {
  path: string;
  values(): Record<string, string>;
};

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function openEnvFile(path: string): EnvFile {
  let lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  return {
    path,
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
