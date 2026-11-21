import { afterAll, expect, test } from "bun:test";
import type { Db } from "../src/db";
import { readNotebook } from "../src/notebook";
import { slackNotebookTools } from "../src/slack";
import { withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const stores: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(stores.map((store) => store.close())));

async function setup() {
  const handle = await tempStore();
  stores.push(handle);
  const db: Db = handle.db;
  await withoutForeignKeys(db);
  const provider = slackNotebookTools({ store: db, now: () => 7 });
  const turn = async (userId: string, channelId = "C1") =>
    (await provider({
      workspaceId: "W1",
      member: { userId, linkId: `link-${userId}` },
      slackUserId: `S${userId}`,
      mentionTs: "1.000002",
      thread: { teamId: "T1", channelId, threadTs: "1.000001", installGeneration: 1 },
      requestId: "r1",
    }))!;
  return { db, turn };
}

const add = (notebook: string, content: string) => ({
  notebook,
  operations: [{ action: "add", content }],
});

test("a channel turn offers only its channel's notebook, and another channel doesn't see its entries", async () => {
  const { turn } = await setup();
  const first = await turn("ann");
  const schema = first.definitions[0]!.inputSchema as {
    properties: { notebook: { enum: string[] } };
  };
  expect(schema.properties.notebook.enum).toEqual(["channel"]);
  expect((await first.call("notebook", add("channel", "canary-channel"))).text).toStartWith(
    "Saved.",
  );
  expect((await turn("bob")).instructions).toContain("Channel notebook:\n- canary-channel");
  const other = await turn("ann", "C2");
  expect(other.instructions).toContain("Channel notebook:\nNo entries yet.");
  expect((await other.call("notebook", { notebook: "channel" })).text).not.toContain(
    "canary-channel",
  );
});

test("a Slack turn can't name a repository, project or user notebook, and nothing is written", async () => {
  const { db, turn } = await setup();
  const tools = await turn("ann");
  for (const kind of ["repository", "project", "user"]) {
    const answer = await tools.call("notebook", add(kind, "canary-refused"));
    expect(answer).toEqual({ text: "notebook must be channel.", isError: true });
  }
  for (const [kind, id] of [
    ["repository", "acme/app"],
    ["project", "p1"],
    ["channel", "T1:C1"],
    ["user", "ann"],
  ] as const)
    expect((await readNotebook(db, { workspaceId: "W1", kind, id })).entries).toEqual([]);
});
