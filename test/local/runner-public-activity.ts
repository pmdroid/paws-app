import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { beginImplementRun, insertQueuedItem, migrate, openDatabase } from "../../src/db";
import { openExecutionJournal, type WorkCommand } from "../../src/runner-journal";
import { RunnerEventSchema } from "../../src/runner-protocol";
import { createLiveStatusProvider, handleStatusRequest } from "../../src/web";

export async function probeRunnerPublicActivity(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const item = insertQueuedItem(db, { id: "activity-item", sessionKey: "visible-session" });
  const { run } = beginImplementRun(db, item.id, 1000);
  const journalRoot = join(root, "journal");
  mkdirSync(journalRoot, { mode: 0o700 });
  let journal = openExecutionJournal(journalRoot);
  const command: WorkCommand = {
    id: "command",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1000,
    expiresAt: 61000,
    runId: run.id,
    itemId: item.id,
    generation: 1,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "codex", model: null },
    prompt: "Inspect source",
  };
  const execution = journal.admit(command, 1000)!;
  const updates: unknown[] = [
    ...["Set", "ting", " ", "up the", " ", "frontend."].map((text) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    })),
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hidden-chain-of-thought" },
    },
  ];
  for (let index = 0; index < 600; index++)
    updates.push(
      {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${index}`,
        title: index === 0 ? "token=x ".repeat(512) : `Read source ${index}`,
        kind: "read",
        status: "in_progress",
        _meta: index === 0 ? { terminal_output_delta: { data: 'token="split' } } : undefined,
        rawInput: {
          command: `cat source-${index}.ts`,
          token: "tool-secret-fixture",
          reasoning: "hidden-input-reasoning",
        },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: `tool-${index}`,
        status: "completed",
        _meta: index === 0 ? { terminal_output_delta: { data: '-credential"' } } : undefined,
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `${index === 599 ? "x".repeat(100_000) : index === 0 ? "token=x ".repeat(32_000) : ""}Source ${index} inspected`,
            },
          },
        ],
      },
    );
  updates.push(
    {
      sessionUpdate: "tool_call",
      toolCallId: "private-tool",
      title: "Private thinking",
      kind: "think",
      status: "in_progress",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "private-tool",
      status: "completed",
      rawOutput: "hidden-tool-reasoning",
    },
    ...["All", " ", "tools", " ", "finished."].map((text) => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    })),
  );
  const rows = updates.map(
    (update) => JSON.stringify({ type: "acp", event: { type: "session_update", update } }) + "\n",
  );
  const prefix = Buffer.from(rows.slice(0, 600).join(""));
  const raw = Buffer.from(rows.join(""));
  try {
    journal.ingest(execution.id, prefix);
    const first = journal.pending(execution.id);
    for (const row of first) journal.sent(execution.id, row.sequence);
    journal.close();
    journal = openExecutionJournal(journalRoot);
    journal.ingest(execution.id, raw);
    const events = [...first, ...journal.pending(execution.id)].map((row) =>
      RunnerEventSchema.parse(JSON.parse(JSON.stringify(row.event))),
    );
    const persistedJournal = openDatabase(join(journalRoot, "executions.db"));
    try {
      const stored = persistedJournal
        .query<{ payload: string }, []>("SELECT payload FROM delivery ORDER BY sequence")
        .all()
        .map((row) => row.payload)
        .join("\n");
      assert(!stored.includes("tool-secret-fixture"));
      assert(!stored.includes("hidden-input-reasoning"));
    } finally {
      persistedJournal.close();
    }
    assert(events.length > 1200);
    assert(events.every((event) => event.type === "activity"));
    assert.equal(
      events.filter(
        (event) => event.type === "activity" && event.update.sessionUpdate === "tool_call",
      ).length,
      601,
    );
    const messages = events.flatMap((event) =>
      event.type === "activity" && event.update.sessionUpdate === "agent_message_chunk"
        ? [event.update.content.text]
        : [],
    );
    assert.deepEqual(messages, ["Setting up the frontend.", "All tools finished."]);
    assert(!JSON.stringify(events).includes("hidden-chain-of-thought"));
    const before = journal.transcriptCursor(execution.id);
    assert.throws(() => journal.ingest(execution.id, Buffer.alloc(16_777_217)), /size limit/);
    assert.deepEqual(journal.transcriptCursor(execution.id), before);
    const directory = join(root, "runs", run.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "acp.jsonl"),
      events
        .map(
          (event) =>
            JSON.stringify({
              t: new Date(1000).toISOString(),
              event:
                event.type === "activity"
                  ? { type: "session_update", sessionId: command.id, update: event.update }
                  : event,
            }) + "\n",
        )
        .join(""),
    );
    const options = {
      db,
      closeoutHome: root,
      sessionIds: ["visible-session"],
      env: { API_KEY: "tool-secret-fixture" },
    };
    const url = `http://127.0.0.1/api/runs/transcript?run=${run.id}`;
    const response = (await handleStatusRequest(new Request(url), options))!;
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const expected of [
      "Setting up the frontend.",
      "cat source-0.ts",
      "Source 0 inspected",
      "cat source-599.ts",
      "Source 599 inspected",
      "All tools finished.",
    ])
      assert(text.includes(expected), expected);
    for (const hidden of [
      "hidden-chain-of-thought",
      "hidden-input-reasoning",
      "hidden-tool-reasoning",
      "tool-secret-fixture",
      "-credential",
    ])
      assert(!text.includes(hidden), hidden);
    assert.equal(
      (await handleStatusRequest(new Request(url), { ...options, sessionIds: ["other-session"] }))!
        .status,
      404,
    );
    assert.equal(
      (await handleStatusRequest(
        new Request(url, { headers: { origin: "https://foreign.example" } }),
        options,
      ))!.status,
      403,
    );
    const streaming = (await handleStatusRequest(new Request(url), options))!;
    const reader = streaming.body!.getReader();
    const firstChunk = await reader.read();
    assert(new TextDecoder().decode(firstChunk.value).includes("Setting up the frontend."));
    await reader.cancel();
    if (process.platform === "linux") {
      const references = readdirSync("/proc/self/fd").flatMap((fd) => {
        try {
          return [readlinkSync(`/proc/self/fd/${fd}`)];
        } catch {
          return [];
        }
      });
      assert(!references.includes(join(directory, "acp.jsonl")));
    }
    const statusRun = createLiveStatusProvider(db, {
      pawsHome: root,
      sessionIds: options.sessionIds,
      env: options.env,
    }).snapshot().runs[0]!;
    assert(!("transcript" in statusRun));
    assert(
      text.includes("Source 0 inspected") &&
        !JSON.stringify(statusRun).includes("Source 0 inspected"),
    );
    const observations = [
      {
        name: "typed public delivery survives restart beyond both former event cutoffs",
        passed: true,
        events: events.length,
        tools: 600,
        messageWhitespacePreserved: true,
        structuredInputsSanitizedBeforeStorage: true,
        rawByteBound: true,
      },
      {
        name: "full scoped transcript retains early and late tools while hiding private content",
        passed: true,
        statusTranscriptEntries: 0,
        fullTranscriptBytes: Buffer.byteLength(text),
        foreignSession: 404,
        foreignOrigin: 403,
        cancellationReleasesFile: true,
      },
    ];
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    journal.close();
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Pass a disposable evidence directory");
  console.log(JSON.stringify(await probeRunnerPublicActivity(root)));
}
