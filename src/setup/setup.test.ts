import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadConfigFile } from "../config";
import { detectCandidates, runSetup } from "./setup";

test("setup offers only installed agents and writes grok", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-setup-"));
  const packageRoot = join(root, "pkg");
  const bin = join(packageRoot, "node_modules", ".bin");
  const platform = join(
    packageRoot,
    "node_modules",
    "@xai-official",
    `grok-${process.platform}-${process.arch}`,
  );
  mkdirSync(bin, { recursive: true });
  mkdirSync(platform, { recursive: true });
  writeFileSync(join(bin, process.platform === "win32" ? "grok.exe" : "grok"), "");
  writeFileSync(join(platform, "package.json"), "{}");
  const candidates = detectCandidates({
    which: (name) =>
      name === "codex-acp" || name === "codex" || name === "grok" ? `/usr/bin/${name}` : null,
    packageRoot,
    agents: { implementer: "claude", grok: { path: null, allowApiKey: false } },
  });
  expect(
    candidates.filter((item) => item.installed && item.loginable).map((item) => item.id),
  ).toEqual(["grok", "codex"]);
  const lines: string[] = [];
  const configPath = join(root, "config.toml");
  const code = await runSetup({
    configPath,
    candidates,
    readLine: async () => "grok",
    write: (text) => lines.push(text),
  });
  expect(code).toBe(0);
  const text = lines.join("");
  expect(text).toContain("1) grok: Run `grok login`");
  expect(text).toContain("2) codex: Run `codex login`");
  expect(text).not.toContain("claude:");
  expect(text).toContain('Wrote agents.implementer = "grok"');
  expect(text).toContain("Run `grok login`");
  expect(loadConfigFile(configPath).agents.implementer).toBe("grok");
  expect(readFileSync(configPath, "utf8")).toContain('implementer = "grok"');
});

test("setup refuses an implementer that is not installed", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-setup-miss-"));
  const lines: string[] = [];
  const code = await runSetup({
    configPath: join(root, "config.toml"),
    candidates: detectCandidates({
      which: () => null,
      packageRoot: join(root, "empty"),
    }),
    choice: "claude",
    write: (text) => lines.push(text),
  });
  expect(code).toBe(1);
  expect(lines.join("")).toContain("No implementer is installed");
});
