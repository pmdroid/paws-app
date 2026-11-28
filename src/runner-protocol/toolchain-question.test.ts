import { expect, test } from "bun:test";
import { formatToolchainQuestion, parseToolchainQuestion, type ToolchainFile } from ".";

const descriptions = [
  "apps/x/package.json needs node, which isn't installed on the runner.",
  "go.mod (and 1 other manifests) needs go, which isn't installed on the runner.",
];
const entries = [
  { name: "node", version: "22.12.0" },
  { name: "go", version: "latest" },
];

test("the mise.toml variant is the text the runner has always sent", () => {
  expect(formatToolchainQuestion({ descriptions, file: "mise.toml", entries })).toBe(
    `${descriptions.join("\n")} Add these entries to the existing [tools] table in mise.toml at the repository root, or create that table if absent. Commit the configuration to main, then answer to retry (do not add a second [tools] header):\n\n[tools]\nnode = "22.12.0"\ngo = "latest"`,
  );
});

test("the .tool-versions variant is the text the runner has always sent", () => {
  expect(formatToolchainQuestion({ descriptions, file: ".tool-versions", entries })).toBe(
    `${descriptions.join("\n")} Add these lines to .tool-versions at the repository root (replace a line that already names the tool). Commit the change to main, then answer to retry:\n\nnode 22.12.0\ngo latest`,
  );
});

for (const file of ["mise.toml", ".tool-versions"] as ToolchainFile[])
  test(`${file}: format then parse gives back the file and entries`, () => {
    expect(
      parseToolchainQuestion(formatToolchainQuestion({ descriptions, file, entries })),
    ).toEqual({ file, entries });
  });

test("an ordinary agent question is not a toolchain question", () => {
  expect(parseToolchainQuestion("Should the retry limit be 3 or 5?")).toBeNull();
  expect(parseToolchainQuestion("")).toBeNull();
});

test("an extra trailing line is refused", () => {
  for (const file of ["mise.toml", ".tool-versions"] as ToolchainFile[]) {
    const text = formatToolchainQuestion({ descriptions, file, entries });
    expect(parseToolchainQuestion(`${text}\n`)).toBeNull();
    expect(parseToolchainQuestion(`${text}\nThanks!`)).toBeNull();
  }
});

test("a version holding a quote or a newline is refused", () => {
  for (const file of ["mise.toml", ".tool-versions"] as ToolchainFile[])
    for (const version of ['22"', "22\n", "22\nrust", "22 x", ""])
      expect(
        parseToolchainQuestion(
          formatToolchainQuestion({ descriptions, file, entries: [{ name: "node", version }] }),
        ),
      ).toBeNull();
});

test("a name outside the allowed characters, a duplicate or no entries is refused", () => {
  const parse = (list: { name: string; version: string }[]) =>
    parseToolchainQuestion(
      formatToolchainQuestion({ descriptions, file: "mise.toml", entries: list }),
    );
  expect(parse([{ name: "no de", version: "1" }])).toBeNull();
  expect(parse([{ name: "a".repeat(65), version: "1" }])).toBeNull();
  expect(parse([entries[0]!, entries[0]!])).toBeNull();
  expect(parse([])).toBeNull();
});
