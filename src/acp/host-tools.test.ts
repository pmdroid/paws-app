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
    terminals.release({ sessionId: "test", terminalId: terminal.terminalId });
    expect(() => terminals.output({ sessionId: "test", terminalId: terminal.terminalId })).toThrow(
      "unknown terminal",
    );
    await terminals.close(50);
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(() => terminals.create({ sessionId: "test", command: "pwd" })).toThrow("run cancelled");
  } finally {
    await terminals.close(50);
    await rm(root, { recursive: true, force: true });
  }
});
