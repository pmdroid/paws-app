import { afterEach, expect, test } from "bun:test";
import { helperSandboxStarts } from "../../test/helper-sandbox";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sandboxedLaunch, writeSandboxed } from "./sandbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sandbox = helperSandboxStarts;

type Paths = { home: string; worktree: string; scratch: string; socket: string };

async function inUnit(script: (paths: Paths) => string, writable?: string) {
  const root = mkdtempSync(join(homedir(), ".paws-sandbox-"));
  roots.push(root);
  const paths: Paths = {
    home: join(root, "home"),
    worktree: join(root, "worktree"),
    scratch: join(root, "scratch"),
    socket: join(root, "listen.sock"),
  };
  mkdirSync(join(paths.home, ".codex", "sessions"), { recursive: true });
  writeFileSync(join(paths.home, ".codex", "auth.json"), "{}");
  mkdirSync(paths.worktree);
  mkdirSync(paths.scratch);
  const server = Bun.listen({ unix: paths.socket, socket: { data() {} } });
  const launch = sandboxedLaunch({
    agent: "codex",
    command: process.execPath,
    args: ["-e", script(paths)],
    env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "sk-test" },
    cwd: paths.worktree,
    scratch: paths.scratch,
    home: paths.home,
    ...(writable ? { writable } : {}),
  });
  expect(launch.args.join(" ")).not.toContain("sk-test");
  const child = Bun.spawn([launch.command, ...launch.args], { env: launch.env, stdout: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  launch.cleanup();
  server.stop(true);
  return { output, paths };
}

const attempt = (label: string, body: string) =>
  `try { ${body}; console.log("${label} ok") } catch (e) { console.log("${label} " + (e.code ?? e.message)) }`;

test.skipIf(!sandbox)(
  "a helper unit can't connect to a Unix socket",
  async () => {
    const { output } = await inUnit(({ socket }) =>
      [
        `console.log("key " + process.env.OPENAI_API_KEY);`,
        `await Bun.connect({ unix: ${JSON.stringify(socket)}, socket: { data() {} } })`,
        `.then(() => console.log("unix connected"), (e) => console.log("unix " + e.code));`,
      ].join("\n"),
    );
    expect(output).toContain("key sk-test");
    expect(output).toMatch(/^unix E[A-Z]+$/m);
  },
  30_000,
);

test.skipIf(!sandbox)(
  "a helper unit can't write the account home's sessions or credential",
  async () => {
    const { output, paths } = await inUnit(({ home }) =>
      [
        attempt(
          "session",
          `require("fs").writeFileSync(${JSON.stringify(join(home, ".codex/sessions/x"))}, "x")`,
        ),
        attempt(
          "credential",
          `require("fs").writeFileSync(${JSON.stringify(join(home, ".codex/auth.json"))}, "x")`,
        ),
        attempt(
          "read",
          `require("fs").readFileSync(${JSON.stringify(join(home, ".codex/auth.json"))})`,
        ),
      ].join("\n"),
    );
    expect(output).toContain("credential EROFS");
    expect(output).toContain("read ok");
    expect(readdirSync(join(paths.home, ".codex", "sessions"))).toEqual([]);
    expect(output).toContain("session ok");
    expect(existsSync(join(paths.scratch, "sessions", "x"))).toBe(true);
  },
  30_000,
);

test.skipIf(!sandbox)(
  "a helper unit can't write into its worktree",
  async () => {
    const { output, paths } = await inUnit(({ worktree }) =>
      attempt(
        "worktree",
        `require("fs").writeFileSync(${JSON.stringify(join(worktree, "x"))}, "x")`,
      ),
    );
    expect(output).toContain("worktree EROFS");
    expect(existsSync(join(paths.worktree, "x"))).toBe(false);
  },
  30_000,
);

test.skipIf(!sandbox)(
  "a helper unit can't write through another process's /proc root",
  async () => {
    const outside = Bun.spawn(["sleep", "30"]);
    const { output, paths } = await inUnit(({ home }) =>
      attempt(
        "proc",
        `require("fs").writeFileSync(${JSON.stringify(`/proc/${outside.pid}/root${home}/escape`)}, "x")`,
      ),
    );
    outside.kill();
    expect(output).toMatch(/^proc E[A-Z]+$/m);
    expect(existsSync(join(paths.home, "escape"))).toBe(false);
  },
  30_000,
);

test("sandboxed helper turns refuse an agent whose credential lives in its data directory", () => {
  expect(() =>
    sandboxedLaunch({
      agent: "opencode",
      command: "x",
      args: [],
      env: {},
      cwd: "/",
      scratch: "/",
      home: "/",
    }),
  ).toThrow("opencode can't run in a sandboxed helper turn");
});

test.skipIf(!sandbox)(
  "a probe_write unit can write only under .agents/probes",
  async () => {
    const { output, paths } = await inUnit(
      ({ worktree }) =>
        [
          ["probe", ".agents/probes/rule.ts"],
          ["agents", ".agents/other.ts"],
          ["root", "x"],
        ]
          .map(([label, path]) =>
            attempt(
              label!,
              `require("fs").writeFileSync(${JSON.stringify(join(worktree, path!))}, "x")`,
            ),
          )
          .join("\n"),
      ".agents/probes",
    );
    expect(output).toContain("probe ok");
    expect(output).toContain("agents EROFS");
    expect(output).toContain("root EROFS");
    expect(readFileSync(join(paths.worktree, ".agents/probes/rule.ts"), "utf8")).toBe("x");
    expect(existsSync(join(paths.worktree, "x"))).toBe(false);
  },
  30_000,
);

function probeTree() {
  const root = mkdtempSync(join(homedir(), ".paws-sandbox-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  const outside = join(root, "outside");
  mkdirSync(worktree);
  mkdirSync(outside);
  mkdirSync(join(root, "scratch"));
  return { root, worktree, outside };
}

test("a probe_write sandbox refuses a writable path through a repository symlink", () => {
  const { root, worktree, outside } = probeTree();
  symlinkSync(outside, join(worktree, ".agents"));
  expect(() =>
    sandboxedLaunch({
      agent: "codex",
      command: "x",
      args: [],
      env: {},
      cwd: worktree,
      scratch: join(root, "scratch"),
      home: root,
      writable: ".agents/probes",
    }),
  ).toThrow("A sandbox path is not a plain directory");
  expect(readdirSync(outside)).toEqual([]);
});

test("a sandboxed turn's ACP writes reach only files directly under its writable folder", () => {
  const { worktree, outside } = probeTree();
  const probes = join(worktree, ".agents", "probes");
  writeSandboxed({ path: join(probes, "rule.ts"), content: "probe" }, worktree, ".agents/probes");
  expect(readFileSync(join(probes, "rule.ts"), "utf8")).toBe("probe");
  symlinkSync(join(outside, "target"), join(probes, "link.ts"));
  for (const [path, writable] of [
    [join(worktree, "x.ts"), ".agents/probes"],
    [join(probes, "nested", "x.ts"), ".agents/probes"],
    [join(probes, "..", "x.ts"), ".agents/probes"],
    [join(probes, "link.ts"), ".agents/probes"],
    [join(probes, "rule.ts"), undefined],
  ] as const)
    expect(() => writeSandboxed({ path, content: "x" }, worktree, writable)).toThrow();
  expect(readdirSync(outside)).toEqual([]);
  expect(existsSync(join(worktree, ".agents", "x.ts"))).toBe(false);
});
