// Screenshots the full agent transcript with a failed workspace hook at desktop width and 390 px.
// Run `bun run build:status` first. Prints the output directory.
import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginImplementRun, insertQueuedItem, migrate, openDatabase } from "../../src/db";
import { createLiveStatusProvider, handleStatusRequest } from "../../src/web";

const root = mkdtempSync(join(tmpdir(), "paws-hook-failure-transcript-"));
const db = openDatabase(join(root, "paws.db"));
migrate(db);
const item = insertQueuedItem(db, { id: "PAS-449", sessionKey: "hook-session" });
const { run } = beginImplementRun(db, item.id, Date.now());
mkdirSync(join(root, "runs", run.id), { recursive: true, mode: 0o700 });
const at = (offset: number) => new Date(Date.now() - 60_000 + offset * 1_000).toISOString();
const line = (offset: number, event: unknown) => `${JSON.stringify({ t: at(offset), event })}\n`;
writeFileSync(
  join(root, "runs", run.id, "acp.jsonl"),
  line(0, {
    type: "session_update",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Formatting the settings page after the edit." },
    },
  }) +
    line(1, {
      type: "session_update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Edit src/web/src/client/hooks.ts",
        kind: "edit",
        status: "completed",
      },
    }) +
    line(2, {
      type: "hook_failed",
      hookId: "hook_fmt",
      hookEvent: "after_edit",
      command: "bun run fmt",
      reason: "exited with 1: src/web/src/client/hooks.ts is not formatted",
    }) +
    line(3, {
      type: "hook_failed",
      hookId: "hook_guard",
      hookEvent: "before_shell",
      command: '"$PAWS_SKILL_DIR/guard-secrets.sh"',
      reason: "timed out after 10s",
    }),
);
const provider = createLiveStatusProvider(db, { pawsHome: root, sessionIds: ["hook-session"] });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    return (
      (await handleStatusRequest(request, {
        provider,
        db,
        closeoutHome: root,
        sessionIds: ["hook-session"],
      })) ?? new Response("Not found", { status: 404 })
    );
  },
});
const browser = await chromium.launch({ headless: true });
try {
  const widths: Record<string, number> = {};
  for (const [name, width, height] of [
    ["desktop", 1440, 900],
    ["390", 390, 844],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${server.url.origin}/status/runs/${run.id}/transcript`);
    await page.getByText("Workspace hook failed (after a file edit)", { exact: false }).waitFor();
    await page.getByText("timed out after 10s", { exact: false }).waitFor();
    widths[name] = await page.evaluate(
      () =>
        (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
          .document.documentElement.scrollWidth,
    );
    if (widths[name]! > width) throw new Error(`Horizontal scroll at ${name}: ${widths[name]}`);
    await page.screenshot({ path: join(root, `transcript-${name}.png`), fullPage: true });
    await page.close();
  }
  console.log(JSON.stringify({ output: root, widths }));
} finally {
  await browser.close();
  await server.stop(true);
  db.close();
}
