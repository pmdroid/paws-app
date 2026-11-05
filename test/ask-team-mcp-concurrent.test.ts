import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tool calls issued together reach the host at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-mcp-"));
  const socketPath = join(dir, "host.sock");
  let open = 0;
  let peak = 0;
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8")) as { arguments: { id: string } };
      open += 1;
      peak = Math.max(peak, open);
      setTimeout(() => {
        open -= 1;
        socket.end(`${JSON.stringify({ answer: `${request.arguments.id} passed.` })}\n`);
      }, 300);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const bridge = Bun.spawn(["bun", join(import.meta.dir, "../src/acp/ask-team-mcp.ts")], {
    env: { ...process.env, PAWS_ASK_TEAM_SOCKET: socketPath, PAWS_HOST_TOOLS: "run_closeout" },
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    const ids = ["install", "lint", "format", "typecheck", "test", "links", "knip", "build"];
    const started = performance.now();
    for (const [index, id] of ids.entries()) {
      bridge.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: index + 1,
          method: "tools/call",
          params: { name: "run_closeout", arguments: { id } },
        })}\n`,
      );
    }
    await bridge.stdin.flush();
    const reader = bridge.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.split("\n").filter(Boolean).length < ids.length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const elapsed = performance.now() - started;
    const answers = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; result: { content: { text: string }[] } });
    expect(answers.map((answer) => answer.id).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    for (const answer of answers)
      expect(answer.result.content[0]?.text).toBe(`${ids[answer.id - 1]} passed.`);
    expect(peak).toBe(ids.length);
    expect(elapsed).toBeLessThan(300 * 3);
  } finally {
    bridge.kill();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
