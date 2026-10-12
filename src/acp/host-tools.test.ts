import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "bun:test";
import { TerminalRegistry } from "./host-tools";

test("closing terminals kills children and rejects later commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-terminal-stop-"));
  const terminals = new TerminalRegistry(
    { worktree: root, home: join(root, "home"), pawsRoot: join(root, "home", ".paws") },
    process.env,
  );
  try {
    const pidFile = join(root, "pid");
    const terminal = terminals.create({
      sessionId: "test",
      command: basename(process.execPath),
      args: [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`,
      ],
    });
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        pid = Number(await readFile(pidFile, "utf8"));
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    expect(pid).toBeDefined();
    await terminals.release({ sessionId: "test", terminalId: terminal.terminalId });
    expect(() => terminals.output({ sessionId: "test", terminalId: terminal.terminalId })).toThrow(
      "unknown terminal",
    );
    await terminals.close(50);
    expect(await stopped(pid!)).toBe(true);
    expect(() => terminals.create({ sessionId: "test", command: "pwd" })).toThrow("run cancelled");
  } finally {
    await terminals.close(50);
    await rm(root, { recursive: true, force: true });
  }
});

async function stopped(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return ["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test.skipIf(process.platform === "win32")(
  "natural terminal exit retains its writing descendant until release finishes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "paws-terminal-natural-"));
    const terminals = new TerminalRegistry(
      { worktree: root, home: join(root, "home"), pawsRoot: join(root, "home", ".paws") },
      process.env,
    );
    let descendant: number | undefined;
    try {
      const pidFile = join(root, "descendant.pid");
      const writes = join(root, "writes");
      const background = `const fs = require('fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => fs.appendFileSync(${JSON.stringify(writes)}, 'x'), 5)`;
      const leader = `const cp = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(background)}], {stdio: 'ignore'}); cp.unref(); const fs = require('fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(writes)})) {clearInterval(timer); process.exit(0)} }, 5)`;
      const terminal = terminals.create({
        sessionId: "test",
        command: basename(process.execPath),
        args: ["-e", leader],
      });
      expect(
        (await terminals.wait({ sessionId: "test", terminalId: terminal.terminalId })).exitCode,
      ).toBe(0);
      descendant = Number(await readFile(pidFile, "utf8"));
      expect(await stopped(descendant)).toBe(false);
      const before = (await readFile(writes)).length;
      await Bun.sleep(30);
      expect((await readFile(writes)).length).toBeGreaterThan(before);
      await terminals.release({ sessionId: "test", terminalId: terminal.terminalId });
      const after = (await readFile(writes)).length;
      for (let attempt = 0; attempt < 100 && !(await stopped(descendant)); attempt += 1)
        await Bun.sleep(5);
      expect(await stopped(descendant)).toBe(true);
      expect((await readFile(writes)).length).toBe(after);
      await Bun.sleep(30);
      expect((await readFile(writes)).length).toBe(after);
      expect(await terminals.close(50)).toBe(true);
    } finally {
      await terminals.close(50);
      if (descendant && !(await stopped(descendant))) process.kill(descendant, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("terminal completion drains command output while its ownership anchor remains alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-terminal-output-"));
  const terminals = new TerminalRegistry(
    { worktree: root, home: join(root, "home"), pawsRoot: join(root, "home", ".paws") },
    process.env,
  );
  try {
    const { terminalId } = terminals.create({
      sessionId: "test",
      command: basename(process.execPath),
      args: ["-e", "process.stdout.write('x'.repeat(250000)); process.stderr.write('finished')"],
    });
    expect((await terminals.wait({ sessionId: "test", terminalId })).exitCode).toBe(0);
    const output = terminals.output({ sessionId: "test", terminalId }).output;
    expect(output.length).toBe(250008);
    expect(output).toContain("finished");
  } finally {
    await terminals.close(50);
    await rm(root, { recursive: true, force: true });
  }
});
