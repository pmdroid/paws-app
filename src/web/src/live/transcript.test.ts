import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginImplementRun, insertQueuedItem, openDatabase, migrate } from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { fullAgentTranscript } from "./transcript";
import { render } from "../client/render";
import { handleStatusRequest } from "../server/handler";

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

test("full transcript reads unfinished ACP output, tools and classification while the status view links to it", async () => {
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
  const env = { API_KEY: "fixture-secret-value" };
  const read = () => [...fullAgentTranscript(home, run.id, new Date(0).toISOString(), env)];
  const first = await provider.snapshot();
  expect("transcript" in first.runs[0]!).toBe(false);
  expect(read().map((x) => x.text)).toEqual([
    "Preparing a screenshot task",
    "Opening create VM dialog <script>bad()</script>",
    "Start browser · in_progress",
    "[redacted]",
  ]);
  const itemId = first.runs[0]!.itemId;
  const html = render({
    route: { view: "issues", id: itemId },
    phase: "ready",
    snapshot: first,
    detail: provider.item(itemId),
    error: null,
    engineUrl: null,
  }).content;
  expect(html).toContain(`href="/status/runs/${run.id}/transcript"`);
  expect(html).toContain('target="_blank"');
  expect(html).toContain("Open full agent transcript");
  expect(html).not.toContain("Opening create VM dialog");
  expect(html).not.toContain("private reasoning");
  appendFileSync(file, "}\n" + JSON.stringify(message("Screenshot captured")) + "\n");
  expect(read().at(-1)?.text).toContain("Screenshot captured");
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
  expect([...fullAgentTranscript(home, "outside", new Date(0).toISOString(), {})]).toEqual([]);
  mkdirSync(join(home, "runs", "file-link"));
  symlinkSync(join(outside, "acp.jsonl"), join(home, "runs", "file-link", "acp.jsonl"));
  expect([...fullAgentTranscript(home, "file-link", new Date(0).toISOString(), {})]).toEqual([]);
  expect([...fullAgentTranscript(home, "../outside", new Date(0).toISOString(), {})]).toEqual([]);
});

test("the transcript route answers JSON entries when the page asks for them", async () => {
  const db = tempDb();
  const home = tempHome();
  const item = insertQueuedItem(db, { id: "json-item", sessionKey: "visible" });
  const { run } = beginImplementRun(db, item.id, 1000);
  mkdirSync(join(home, "runs", run.id), { recursive: true });
  writeFileSync(
    join(home, "runs", run.id, "acp.jsonl"),
    [message("First line\n\nwith a blank line"), message(" continues")]
      .map((x) => JSON.stringify({ t: "2026-10-19T10:00:00.000Z", ...x }) + "\n")
      .join(""),
  );
  const url = `http://127.0.0.1/api/runs/transcript?run=${run.id}`;
  const options = { db, closeoutHome: home, sessionIds: ["visible"] };
  const asked = (await handleStatusRequest(
    new Request(url, { headers: { Accept: "application/json" } }),
    options,
  ))!;
  expect(asked.headers.get("content-type")).toContain("application/json");
  expect(await asked.json()).toEqual([
    {
      at: "2026-10-19T10:00:00.000Z",
      kind: "system",
      text: "First line\n\nwith a blank line continues",
    },
  ]);
  const plain = (await handleStatusRequest(new Request(url), options))!;
  expect(plain.headers.get("content-type")).toContain("text/plain");
  rmSync(join(home, "runs", run.id, "acp.jsonl"));
  const empty = (await handleStatusRequest(
    new Request(url, { headers: { Accept: "application/json" } }),
    options,
  ))!;
  expect(await empty.json()).toEqual([]);
  const hidden = (await handleStatusRequest(
    new Request(url, { headers: { Accept: "application/json" } }),
    { ...options, sessionIds: ["other"] },
  ))!;
  expect(hidden.status).toBe(404);
  db.close();
});

test("a failing workspace hook shows on the run page as an error", () => {
  const home = tempHome();
  mkdirSync(join(home, "runs", "hook-run"), { recursive: true });
  writeFileSync(
    join(home, "runs", "hook-run", "acp.jsonl"),
    `${JSON.stringify({
      t: "2026-10-22T10:00:00.000Z",
      event: {
        type: "hook_failed",
        hookId: "hook_fmt",
        hookEvent: "after_edit",
        command: "bun run fmt",
        reason: "exited with 1: fmt failed",
      },
    })}\n`,
  );
  expect([...fullAgentTranscript(home, "hook-run", new Date(0).toISOString(), {})]).toEqual([
    {
      at: "2026-10-22T10:00:00.000Z",
      kind: "err",
      text: "Workspace hook failed (after a file edit): bun run fmt · exited with 1: fmt failed",
    },
  ]);
});
