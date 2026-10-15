import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, migrate, insertQueuedItem, beginImplementRun } from "../../src/db";
import { createLiveStatusProvider, handleStatusRequest } from "../../src/web";

const root = process.argv[2]!;
mkdirSync(root, { recursive: true, mode: 0o700 });
const db = openDatabase(join(root, "paws.db"));
migrate(db);
const item = insertQueuedItem(db, { id: "PAS-306", sessionKey: "transcript-session" });
const { run } = beginImplementRun(db, item.id, Date.now());
const directory = join(root, "runs", run.id);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = join(directory, "acp.jsonl");
const message = (text: string) =>
  JSON.stringify({
    t: new Date().toISOString(),
    event: {
      type: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  }) + "\n";
writeFileSync(
  file,
  message("Opening the create VM dialog") +
    JSON.stringify({
      event: {
        type: "session_update",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "private reasoning" },
        },
      },
    }) +
    "\n" +
    JSON.stringify({
      event: {
        type: "session_update",
        update: { sessionUpdate: "tool_call", title: "Launch Chromium", status: "in_progress" },
      },
    }) +
    "\n",
);
const provider = createLiveStatusProvider(db, {
  pawsHome: root,
  sessionIds: ["transcript-session"],
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/__append" && request.method === "POST") {
      appendFileSync(file, message("Screenshot captured on the runner"));
      return Response.json({ ok: true });
    }
    return (
      (await handleStatusRequest(request, { provider, db })) ??
      new Response("Not found", { status: 404 })
    );
  },
});
console.log(JSON.stringify({ origin: server.url.origin, runId: run.id }));
process.on("SIGTERM", async () => {
  await server.stop(true);
  db.close();
  process.exit(0);
});
await new Promise(() => {});
