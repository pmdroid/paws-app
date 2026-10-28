import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHostToolBridge } from "./ask-team";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("show_preview validates the tool input and forwards only the normalized request", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-preview-tool-"));
  roots.push(root);
  const requests: unknown[] = [];
  const bridge = await startHostToolBridge({
    socketPath: join(root, "tools.sock"),
    context: { itemId: "item", runId: "run", role: "implementer", worktreePath: root },
    signal: new AbortController().signal,
    showPreview: {
      async show(request) {
        requests.push(request);
        return "Preview accepted";
      },
    },
  });
  async function call(args: unknown) {
    return await new Promise<{ answer?: string; error?: string }>((resolve, reject) => {
      const socket = connect(join(root, "tools.sock"));
      let data = "";
      socket.on("data", (part) => {
        data += part;
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(JSON.parse(data)));
      socket.write(`${JSON.stringify({ id: "preview", tool: "show_preview", arguments: args })}\n`);
    });
  }
  try {
    const args = { command: ["bun", "run", "fixtures"], port: 3123, checklist: ["Try sign-in"] };
    expect((await call({ ...args, port: 22 })).error).toBeDefined();
    expect((await call({ ...args, startPath: "//outside.example" })).error).toBeDefined();
    expect(requests).toHaveLength(0);
    expect((await call(args)).answer).toBe("Preview accepted");
    expect(requests).toEqual([{ ...args, startPath: "/", checkId: "live-preview" }]);
  } finally {
    await bridge.close();
  }
});
