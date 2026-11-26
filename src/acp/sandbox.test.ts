import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sandboxedLaunch } from "./sandbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sandbox =
  spawnSync(
    "/usr/bin/systemd-run",
    ["--user", "-q", "--pipe", "--wait", "-p", "PrivateTmp=yes", "true"],
    {
      env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` },
    },
  ).status === 0;

type Paths = { home: string; worktree: string; scratch: string; socket: string };

async function inUnit(script: (paths: Paths) => string) {
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
