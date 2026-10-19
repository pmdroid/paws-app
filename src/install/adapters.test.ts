import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect, test } from "bun:test";
import {
  CLAUDE_AGENT_ACP_PACKAGE,
  CODEX_ACP_PACKAGE,
  adapterVersions,
  pinnedAdapters,
  resolveAdapter,
} from "../acp";

const root = join(import.meta.dir, "../..");

test("resolves both pinned adapters from node_modules/.bin", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const versions = adapterVersions(root);
  expect(pkg.dependencies[CLAUDE_AGENT_ACP_PACKAGE]).toBe(versions.claudeAgentAcp);
  expect(pkg.dependencies[CODEX_ACP_PACKAGE]).toBe(versions.codexAcp);
  expect(versions.claudeAgentAcp).toBe("0.88.0");
  expect(versions.codexAcp).toBe("2.1.1");

  const pins = pinnedAdapters(root);
  const implementer = resolveAdapter("implementer", {}, undefined, root);
  const reviewer = resolveAdapter("reviewer", {}, undefined, root);
  expect(implementer).toEqual({ command: pins.implementer.command, args: [] });
  expect(reviewer).toEqual({ command: pins.reviewer.command, args: [] });
  expect(isAbsolute(implementer.command)).toBe(true);
  expect(isAbsolute(reviewer.command)).toBe(true);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const posixPath = (path: string) => path.replaceAll("\\", "/");
  expect(
    posixPath(implementer.command).endsWith(`/node_modules/.bin/claude-agent-acp${suffix}`),
  ).toBe(true);
  expect(posixPath(reviewer.command).endsWith(`/node_modules/.bin/codex-acp${suffix}`)).toBe(true);
  expect(implementer.command).not.toBe("claude-agent-acp");
  expect(reviewer.command).not.toBe("codex-acp");
  expect(existsSync(implementer.command)).toBe(true);
  expect(existsSync(reviewer.command)).toBe(true);
});

test("keeps an explicit adapter override and does not search PATH", () => {
  expect(
    resolveAdapter("implementer", { PAWS_CLAUDE_ACP: "/opt/claude-agent-acp --verbose" }),
  ).toEqual({
    command: "/opt/claude-agent-acp",
    args: ["--verbose"],
  });
  expect(resolveAdapter("reviewer", {}, { command: "/tmp/codex-acp", args: ["--flag"] })).toEqual({
    command: "/tmp/codex-acp",
    args: ["--flag"],
  });
});
