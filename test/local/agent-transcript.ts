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
  message("Opening ") +
    message("the create VM dialog") +
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
    "\n" +
    [
      [
        "Read src/vm/create-dialog.tsx",
        'export function CreateVmDialog() {\n  const [name, setName] = useState("");\n  return <Dialog title="Create VM">…</Dialog>;\n}',
      ],
      [
        "bun test src/vm",
        "src/vm/create-dialog.test.tsx:\n✓ opens with an empty name [12.40ms]\n✓ rejects a duplicate name [8.11ms]\n✗ keeps the region after a validation error [5.02ms]\n\n 2 pass\n 1 fail",
      ],
      [
        "Edit src/vm/create-dialog.tsx",
        "Keep the selected region in form state when validation fails.",
      ],
      [
        "bun test src/vm",
        "src/vm/create-dialog.test.tsx:\n✓ opens with an empty name [11.87ms]\n✓ rejects a duplicate name [7.95ms]\n✓ keeps the region after a validation error [4.63ms]\n\n 3 pass\n 0 fail",
      ],
    ]
      .map(
        ([title, output], index) =>
          message(
            [
              "Reading the dialog before changing it.",
              "Running the dialog tests first.",
              "One test fails: the region resets after a validation error. Fixing the form state.",
              "The dialog keeps the region now. Running the suite again.",
            ][index]!,
          ) +
          JSON.stringify({
            t: new Date().toISOString(),
            event: {
              type: "session_update",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: `tool-${index}`,
                title,
                kind: "execute",
                status: "completed",
                rawOutput: output,
              },
            },
          }) +
          "\n",
      )
      .join(""),
);
const provider = createLiveStatusProvider(db, {
  pawsHome: root,
  sessionIds: ["transcript-session"],
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__append" && request.method === "POST") {
      const title = url.searchParams.get("tool");
      appendFileSync(
        file,
        title === null
          ? message("Screenshot captured on the runner")
          : JSON.stringify({
              t: new Date().toISOString(),
              event: {
                type: "session_update",
                update: { sessionUpdate: "tool_call", title, status: "completed" },
              },
            }) + "\n",
      );
      return Response.json({ ok: true });
    }
    return (
      (await handleStatusRequest(request, {
        provider,
        db,
        closeoutHome: root,
        sessionIds: ["transcript-session"],
      })) ?? new Response("Not found", { status: 404 })
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
