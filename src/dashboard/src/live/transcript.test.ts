import { openedView } from "../../test/fixtures";
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
import { sqliteDb, beginImplementRun, insertQueuedItem, openDatabase, migrate } from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { fullAgentTranscript } from "./transcript";
import { render } from "../client/render";
import { handleStatusRequest } from "../server/handler";
import { setJournalSink } from "../journal";

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
  const { run } = await beginImplementRun(sqliteDb(db), item.id, 1000);
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
  const first = await provider.issues();
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
    issue: await provider.issue(itemId),
    error: null,
    engineUrl: null,
    closeout: openedView(),
  }).content;
  expect(html).toContain(`href="/dashboard/runs/${run.id}/transcript"`);
  expect(html).toContain('target="_blank"');
  expect(html).toContain("Open full agent transcript");
  expect(html).not.toContain("Opening create VM dialog");
  expect(html).not.toContain("private reasoning");
  appendFileSync(file, "}\n" + JSON.stringify(message("Screenshot captured")) + "\n");
  expect(read().at(-1)?.text).toContain("Screenshot captured");
  expect(
    (await createLiveStatusProvider(db, { pawsHome: home, sessionIds: ["other"] }).issues()).runs,
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
  const { run } = await beginImplementRun(sqliteDb(db), item.id, 1000);
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
      session: 1,
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
      session: 1,
    },
  ]);
});

test("untimed lines take the previous line's time, and a partly written last line is skipped quietly", () => {
  const home = tempHome();
  mkdirSync(join(home, "runs", "resumed-run"), { recursive: true });
  const start = "2026-11-03T18:00:00.000Z";
  const first = "2026-11-03T18:05:00.000Z";
  const last = "2026-11-03T18:28:00.000Z";
  const tool = (title: string, t?: string) => ({
    ...(t ? { t } : {}),
    event: { type: "session_update", update: { sessionUpdate: "tool_call", title } },
  });
  writeFileSync(
    join(home, "runs", "resumed-run", "acp.jsonl"),
    [tool("before"), tool("first", first), tool("a"), tool("b"), tool("c"), tool("last", last)]
      .map((x) => JSON.stringify(x) + "\n")
      .join("") + '{"event":{"type":"progr',
  );
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    expect(
      [...fullAgentTranscript(home, "resumed-run", start, {})].map((x) => [x.text, x.at]),
    ).toEqual([
      ["before", start],
      ["first", first],
      ["a", first],
      ["b", first],
      ["c", first],
      ["last", last],
    ]);
  } finally {
    restore();
  }
  expect(lines.filter((line) => line.includes("transcript.readFile.parse"))).toEqual([]);
});

test("each start line the runner backend writes begins the next session", () => {
  const home = tempHome();
  mkdirSync(join(home, "runs", "sessions-run"), { recursive: true });
  mkdirSync(join(home, "runs", "sessions-run-classify"), { recursive: true });
  const progress = (text: string) => ({ event: { type: "progress", text } });
  writeFileSync(
    join(home, "runs", "sessions-run-classify", "acp.jsonl"),
    JSON.stringify(message("Classifying")) + "\n",
  );
  writeFileSync(
    join(home, "runs", "sessions-run", "acp.jsonl"),
    [
      message("Before any start"),
      progress("Starting on runner-a.\n"),
      message("First work"),
      progress("Continuing the agent's session on runner-a.\n"),
      message("Follow-up"),
      progress("Starting a new session on runner-b; runner-a is unavailable.\n"),
      message("Fresh start"),
    ]
      .map((x) => JSON.stringify(x) + "\n")
      .join(""),
  );
  expect(
    [...fullAgentTranscript(home, "sessions-run", new Date(0).toISOString(), {})].map((x) => [
      x.session,
      x.text,
    ]),
  ).toEqual([
    [1, "Classifying"],
    [1, "Before any start"],
    [1, "Starting on runner-a.\nFirst work"],
    [2, "Continuing the agent's session on runner-a.\nFollow-up"],
    [3, "Starting a new session on runner-b; runner-a is unavailable.\nFresh start"],
  ]);
});

test("a transcript without start lines is one session", () => {
  const home = tempHome();
  mkdirSync(join(home, "runs", "old-run"), { recursive: true });
  writeFileSync(
    join(home, "runs", "old-run", "acp.jsonl"),
    [message("One"), { event: { type: "progress", text: "Tool: ls" } }, message("Two")]
      .map((x) => JSON.stringify(x) + "\n")
      .join(""),
  );
  expect(
    [...fullAgentTranscript(home, "old-run", new Date(0).toISOString(), {})].map((x) => x.session),
  ).toEqual([1, 1, 1]);
});
