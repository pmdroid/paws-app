import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { helperSandboxStarts } from "../../test/helper-sandbox";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

const FAKE_OPENCODE = `
const { Database } = require("bun:sqlite");
const turn = process.env.OPENCODE_DB;
if (process.argv[2] === "auth") {
  require("fs").mkdirSync(require("path").dirname(turn), { recursive: true });
  const db = new Database(turn);
  db.run("CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)");
  db.close();
  process.exit(0);
}
const db = new Database(turn);
console.log("seeded " + db.query("SELECT value FROM credential").get().value);
db.run("UPDATE credential SET value = 'refreshed'");
db.close();
try { new Database(process.argv[2]).run("UPDATE credential SET value = 'x'"); console.log("account ok") }
catch (e) { console.log("account " + (e.code ?? e.message)) }
console.log("cwd " + process.cwd());
console.log("turn " + turn);
for await (const line of console) { if (line === "go") break }
`;

test.skipIf(!sandbox)(
  "an OpenCode helper unit gets the credential only in its own tmpfs and can't change the account's",
  async () => {
    const root = mkdtempSync(join(homedir(), ".paws-sandbox-"));
    roots.push(root);
    const home = join(root, "home");
    const worktree = join(root, "worktree");
    const scratch = join(root, "scratch");
    const account = join(home, ".local/share/opencode/opencode.db");
    const credential = join(home, ".paws/opencode-credential.json");
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(home, ".paws"));
    mkdirSync(worktree);
    mkdirSync(scratch);
    const value = JSON.stringify({ type: "oauth", access: "access-1", refresh: "" });
    writeFileSync(credential, value);
    const db = new Database(account);
    db.run(
      "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)",
    );
    db.run(`INSERT INTO credential VALUES ('c1', 'opencode', 'OAuth', ?, 1, 1, 1)`, [value]);
    db.close();
    const before = readFileSync(account);
    const fake = join(root, "opencode.js");
    writeFileSync(fake, `#!${process.execPath}\n${FAKE_OPENCODE}`, { mode: 0o755 });
    const launch = sandboxedLaunch({
      agent: "opencode",
      command: fake,
      args: [account],
      env: { PATH: "/usr/bin:/bin", HOME: home, OPENCODE_DB: account },
      cwd: worktree,
      scratch,
      home,
    });
    expect(launch.args.join(" ")).not.toContain("access-1");
    const child = Bun.spawn([launch.command, ...launch.args], {
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
    });
    let output = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk);
      if (output.includes("\nturn ")) break;
    }
    const turn = /^turn (.+)$/m.exec(output)?.[1] ?? "";
    expect(turn.startsWith(join(scratch, "opencode") + "/")).toBe(true);
    expect(existsSync(turn)).toBe(false);
    expect(readdirSync(join(scratch, "opencode"))).toEqual([]);
    void child.stdin.write("go\n");
    await child.stdin.end();
    await child.exited;
    launch.cleanup();
    expect(child.exitCode).toBe(0);
    expect(output).toContain(`seeded ${value}`);
    expect(output).toMatch(/^account SQLITE_(READONLY|CANTOPEN)/m);
    expect(output).toContain(`cwd ${worktree}`);
    expect(readdirSync(join(scratch, "opencode"))).toEqual([]);
    expect(readFileSync(account).equals(before)).toBe(true);
    expect(readFileSync(credential, "utf8")).toBe(value);
  },
  60_000,
);

test("an OpenCode helper unit keeps its data in a private tmpfs and never gets the credential in its arguments or environment", () => {
  const root = mkdtempSync(join(homedir(), ".paws-sandbox-"));
  roots.push(root);
  mkdirSync(join(root, "home", ".paws"), { recursive: true });
  writeFileSync(join(root, "home", ".paws", "opencode-credential.json"), '{"access":"access-1"}');
  const launch = sandboxedLaunch({
    agent: "opencode",
    command: "/usr/bin/opencode",
    args: ["acp"],
    env: { PATH: "/usr/bin:/bin", OPENCODE_DB: "/elsewhere.db" },
    cwd: root,
    scratch: root,
    home: join(root, "home"),
  });
  const data = join(realpathSync(root), "opencode");
  expect(launch.args).toContain(`TemporaryFileSystem=${data}:mode=0700`);
  expect(launch.args.some((arg) => arg.startsWith("BindPaths="))).toBe(false);
  expect(launch.env.OPENCODE_DB).toBe(join(data, "share", "opencode", "opencode.db"));
  expect(launch.env.XDG_DATA_HOME).toBe(join(data, "share"));
  expect(`${launch.args.join(" ")} ${Object.values(launch.env).join(" ")}`).not.toContain(
    "access-1",
  );
  expect(launch.args.slice(-2)).toEqual(["/usr/bin/opencode", "acp"]);
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
