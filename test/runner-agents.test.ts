import { expect, test } from "bun:test";

// The agent installer tests in linux-release-test.py, run against a local fake npm registry with
// this Bun: an integrity mismatch is refused, install scripts don't run, a second version installs
// beside the first, `current` waits for sessions on the old one, and every launcher runs a fake task.
// The update tests apply requests forwarded from Paws: only the version and integrity Paws sent install,
// a running session keeps its version until it ends, and a rollback switches back without npm.
test("the runner installer installs the coding agents from pinned, integrity-checked lockfiles", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      new URL("local/linux-release-test.py", import.meta.url).pathname,
      new URL("../deploy/linux/release.py", import.meta.url).pathname,
      "AgentInstallation",
    ],
    {
      env: { PATH: "/usr/bin:/bin", LANG: "C", PAWS_TEST_BUN: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout + stderr).not.toContain("skipped");
  expect(stderr).toMatch(/Ran 10 tests[\s\S]*\nOK\n?$/);
  expect(code).toBe(0);
});

test("agents.json pins the same agent versions as package.json and lists every package's sha512", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const manifest = await Bun.file(new URL("../deploy/linux/agents.json", import.meta.url)).json();
  const packages: Record<string, string> = {
    claude: "@agentclientprotocol/claude-agent-acp",
    codex: "@agentclientprotocol/codex-acp",
    grok: "@xai-official/grok",
  };
  expect(Object.keys(manifest.agents).sort()).toEqual(Object.keys(packages));
  for (const [agent, name] of Object.entries(packages)) {
    const entry = manifest.agents[agent];
    expect(entry.package).toBe(name);
    expect(entry.version).toBe(pkg.dependencies[name]);
    for (const item of entry.packages)
      expect(item.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  }
  const paths = (agent: string) =>
    manifest.agents[agent].packages.map((item: { path: string }) => item.path);
  for (const arch of ["x64", "arm64"]) {
    expect(paths("claude")).toContain(`@anthropic-ai/claude-agent-sdk-linux-${arch}`);
    expect(paths("codex")).toContain(`@openai/codex-linux-${arch}`);
    expect(paths("grok")).toContain(`@xai-official/grok-linux-${arch}`);
  }
});
