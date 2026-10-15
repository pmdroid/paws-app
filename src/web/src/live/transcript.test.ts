import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginImplementRun, insertQueuedItem, openDatabase, migrate } from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { readAgentTranscript } from "./transcript";
import { render } from "../client/render";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "paws-transcript-"));
}
function tempDb() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

function message(text: string) {
  return {
    event: {
      type: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
}

test("run transcript refreshes unfinished ACP output, tools and classification through the scoped status view", async () => {
  const db = tempDb();
  const home = tempHome();
  const item = insertQueuedItem(db, { id: "transcript-item", sessionKey: "visible" });
  const { run } = beginImplementRun(db, item.id, 1000);
  const directory = join(home, "runs", run.id);
  mkdirSync(directory, { recursive: true });
  mkdirSync(`${directory}-classify`);
  writeFileSync(
    join(`${directory}-classify`, "acp.jsonl"),
    JSON.stringify(message("Preparing a screenshot task")) + "\n",
  );
  const file = join(directory, "acp.jsonl");
  const hidden = {
    event: {
      type: "session_update",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "private reasoning" },
      },
    },
  };
  const tool = {
    event: {
      type: "session_update",
      update: { sessionUpdate: "tool_call", title: "Start browser", status: "in_progress" },
    },
  };
  writeFileSync(
    file,
    [
      message("Opening create VM dialog <script>bad()</script>"),
      hidden,
      tool,
      message("fixture-secret-"),
      message("value"),
    ]
      .map((x) => JSON.stringify(x) + "\n")
      .join("") + "{unfinished",
  );
  const provider = createLiveStatusProvider(db, {
    pawsHome: home,
    sessionIds: ["visible"],
    env: { API_KEY: "fixture-secret-value" },
  });
  const first = await provider.snapshot();
  const transcript = first.runs[0]!.transcript!;
  expect(transcript.map((x) => x.text)).toEqual([
    "Preparing a screenshot task",
    "Opening create VM dialog <script>bad()</script>",
    "Start browser · in_progress",
    "[redacted]",
  ]);
  const html = render({
    route: { view: "runs", id: run.id },
    phase: "ready",
    snapshot: first,
    via: "engine",
    error: null,
    engineUrl: null,
    selectedCheck: null,
  }).content;
  expect(html).toContain('aria-label="Agent transcript"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("private reasoning");
  appendFileSync(file, "}\n" + JSON.stringify(message("Screenshot captured")) + "\n");
  expect((await provider.snapshot()).runs[0]!.transcript!.at(-1)?.text).toContain(
    "Screenshot captured",
  );
  expect(
    (await createLiveStatusProvider(db, { pawsHome: home, sessionIds: ["other"] }).snapshot()).runs,
  ).toEqual([]);
  db.close();
});

test("transcript reader refuses outside directories, symlink files and incomplete records", () => {
  const home = tempHome();
  const outside = tempHome();
  mkdirSync(join(home, "runs"));
  writeFileSync(join(outside, "acp.jsonl"), JSON.stringify(message("outside")) + "\n");
  symlinkSync(outside, join(home, "runs", "outside"));
  expect(readAgentTranscript(home, "outside", new Date(0).toISOString(), {})).toEqual([]);
  mkdirSync(join(home, "runs", "file-link"));
  symlinkSync(join(outside, "acp.jsonl"), join(home, "runs", "file-link", "acp.jsonl"));
  expect(readAgentTranscript(home, "file-link", new Date(0).toISOString(), {})).toEqual([]);
  expect(readAgentTranscript(home, "../outside", new Date(0).toISOString(), {})).toEqual([]);
});
