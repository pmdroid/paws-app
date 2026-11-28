export type ToolchainFile = "mise.toml" | ".tool-versions";
export type ToolchainEntry = { name: string; version: string };
export type ToolchainQuestion = { file: ToolchainFile; entries: ToolchainEntry[] };

const INSTRUCTIONS: Record<ToolchainFile, string> = {
  ".tool-versions":
    " Add these lines to .tool-versions at the repository root (replace a line that already names the tool). Commit the change to main, then answer to retry:\n\n",
  "mise.toml":
    " Add these entries to the existing [tools] table in mise.toml at the repository root, or create that table if absent. Commit the configuration to main, then answer to retry (do not add a second [tools] header):\n\n[tools]\n",
};

const TOKEN = "[A-Za-z0-9._-]{1,64}";
const LINES: Record<ToolchainFile, RegExp> = {
  ".tool-versions": new RegExp(`^(${TOKEN}) (${TOKEN})$`),
  "mise.toml": new RegExp(`^(${TOKEN}) = "(${TOKEN})"$`),
};

function line(file: ToolchainFile, { name, version }: ToolchainEntry): string {
  return file === "mise.toml" ? `${name} = "${version}"` : `${name} ${version}`;
}

export function formatToolchainQuestion(question: {
  descriptions: readonly string[];
  file: ToolchainFile;
  entries: readonly ToolchainEntry[];
}): string {
  return `${question.descriptions.join("\n")}${INSTRUCTIONS[question.file]}${question.entries
    .map((entry) => line(question.file, entry))
    .join("\n")}`;
}

export function parseToolchainQuestion(text: string): ToolchainQuestion | null {
  for (const file of ["mise.toml", ".tool-versions"] as const) {
    const at = text.lastIndexOf(INSTRUCTIONS[file]);
    if (at <= 0) continue;
    const entries: ToolchainEntry[] = [];
    for (const row of text.slice(at + INSTRUCTIONS[file].length).split("\n")) {
      const match = LINES[file].exec(row);
      if (!match || entries.some((entry) => entry.name === match[1])) return null;
      entries.push({ name: match[1]!, version: match[2]! });
    }
    return { file, entries };
  }
  return null;
}
