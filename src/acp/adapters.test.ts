import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentsConfig } from "../config";
import {
  adapterBinPath,
  GROK_AGENT_ARGS,
  pawsPackageRoot,
  resolveAdapter,
  resolveGrokCommand,
  selectGrokAuthMethod,
} from "./adapters";

const grok: AgentsConfig = { implementer: "grok" };

test("grok adapter args never auto-approve", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-grok-bin-"));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  mkdirSync(
    join(root, "node_modules", "@xai-official", `grok-${process.platform}-${process.arch}`),
    { recursive: true },
  );
  const bin = join(root, "node_modules", ".bin", "grok");
  writeFileSync(bin, "");
  const command = resolveAdapter("implementer", {}, undefined, root, grok);
  expect(command).toEqual({
    command: bin,
    args: [...GROK_AGENT_ARGS],
  });
  expect(command.args.join(" ")).not.toContain("always-approve");
  expect(command.args.join(" ")).not.toContain("yolo");
  expect(command.args).toEqual(["--no-auto-update", "agent", "stdio"]);
});

test("a missing pinned grok says to run bun install", () => {
  const missing = resolveGrokCommand(mkdtempSync(join(tmpdir(), "paws-no-grok-")));
  expect(missing.error).toContain("node_modules/.bin/grok");
  expect(missing.error).toContain("bun install");
});

test("missing platform package is a clear error", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-no-platform-"));
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "grok"), "#!/bin/sh\n");
  const resolved = resolveGrokCommand(root);
  expect(resolved.error).toContain("no platform binary");
  expect(resolved.error).toContain(`${process.platform}-${process.arch}`);
  expect(resolved.error).not.toContain("agents.grok");
});

test("pinned grok resolves from node_modules/.bin on a supported platform", () => {
  const resolved = resolveGrokCommand(pawsPackageRoot());
  expect(resolved.args).toEqual([...GROK_AGENT_ARGS]);
  if (process.platform === "linux" && process.arch === "x64") {
    expect(resolved.error).toBeNull();
    expect(resolved.command).toBe(join(pawsPackageRoot(), "node_modules", ".bin", "grok"));
  } else if (resolved.error) {
    expect(resolved.error).toContain("no platform binary");
  }
});

test("reviewer stays codex when the implementer is grok", () => {
  expect(resolveAdapter("reviewer", {}, undefined, undefined, grok)).toEqual({
    command: join(pawsPackageRoot(), "node_modules", ".bin", "codex-acp"),
    args: [],
  });
  expect(resolveAdapter("implementer", { PAWS_CLAUDE_ACP: "/bin/claude" })).toEqual({
    command: "/bin/claude",
    args: [],
  });
});

test("grok always signs in with its cached login", () => {
  expect(selectGrokAuthMethod([{ id: "cached_token" }, { id: "xai.api_key" }])).toBe(
    "cached_token",
  );
  expect(selectGrokAuthMethod([{ id: "xai.api_key" }])).toBeNull();
  expect(selectGrokAuthMethod([])).toBeNull();
});

test("a runner release without bundled agents runs the installed agent launchers", () => {
  const base = mkdtempSync(join(tmpdir(), "paws-runner-base-"));
  const release = join(base, "releases", "1.2.3");
  mkdirSync(join(release, "node_modules"), { recursive: true });
  mkdirSync(join(base, "bin"));
  for (const name of ["claude-agent-acp", "codex-acp", "grok"])
    writeFileSync(join(base, "bin", name), "#!/bin/sh\n");
  expect(adapterBinPath("implementer", release, base)).toBe(join(base, "bin", "claude-agent-acp"));
  expect(adapterBinPath("reviewer", join(base, "current"), base)).toBe(
    join(base, "bin", "codex-acp"),
  );
  expect(resolveGrokCommand(release, base)).toEqual({
    command: join(base, "bin", "grok"),
    args: [...GROK_AGENT_ARGS],
    error: null,
  });
  // A checkout keeps its own node_modules/.bin even on a host with installed launchers.
  const checkout = mkdtempSync(join(tmpdir(), "paws-checkout-"));
  expect(adapterBinPath("implementer", checkout, base)).toBe(
    join(checkout, "node_modules", ".bin", "claude-agent-acp"),
  );
});
