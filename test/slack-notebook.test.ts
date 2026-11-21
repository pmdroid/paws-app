import { afterAll, expect, test } from "bun:test";
import type { Db } from "../src/db";
import { notebookChanges, readNotebook } from "../src/notebook";
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
  const turn = async (userId: string, options: { direct?: boolean; channelId?: string } = {}) =>
    (await provider({
      workspaceId: "W1",
      member: { userId, linkId: `link-${userId}` },
      slackUserId: `S${userId}`,
      mentionTs: "1.000002",
      thread: {
        teamId: "T1",
        channelId: options.channelId ?? (options.direct ? `D${userId}` : "C1"),
        threadTs: "1.000001",
        installGeneration: 1,
      },
      requestId: "r1",
      ...(options.direct ? { direct: true } : {}),
    }))!;
  return { db, turn };
}

const enumOf = (tools: { definitions: { inputSchema: Record<string, unknown> }[] }) =>
  (tools.definitions[0]!.inputSchema as { properties: { notebook: { enum: string[] } } }).properties
    .notebook.enum;

const add = (notebook: string, content: string) => ({
  notebook,
  operations: [{ action: "add", content }],
});

test("a direct message writes only the person's private notebook, which no one else's turn shows", async () => {
  const { db, turn } = await setup();
  const ann = await turn("ann", { direct: true });
  expect(enumOf(ann)).toEqual(["user"]);
  expect(ann.instructions).toContain("Your notebook:\nNo entries yet.");
  expect(ann.instructions).toContain("only they can read it");
  expect((await ann.call("notebook", add("user", "canary-private"))).text).toStartWith("Saved.");
  const scope = { workspaceId: "W1", kind: "user", id: "ann" } as const;
  expect((await readNotebook(db, scope)).entries.map((entry) => entry.body)).toEqual([
    "canary-private",
  ]);
  expect((await notebookChanges(db, scope)).map((change) => change.actorId)).toEqual(["ann"]);
  expect((await turn("ann", { direct: true })).instructions).toContain("- canary-private");
  for (const other of [
    await turn("bob", { direct: true }),
    await turn("ann"),
    await turn("ann", { channelId: "C2" }),
  ]) {
    expect(other.instructions).not.toContain("canary-private");
    expect((await other.call("notebook", { notebook: enumOf(other)[0]! })).text).not.toContain(
      "canary-private",
    );
  }
  expect(enumOf(await turn("ann"))).toEqual(["channel"]);
});

test("a Slack turn can't name a repository, project or another conversation's notebook", async () => {
  const { db, turn } = await setup();
  const channel = await turn("ann");
  const direct = await turn("ann", { direct: true });
  for (const [tools, kind] of [
    [channel, "repository"],
    [channel, "project"],
    [channel, "user"],
    [direct, "repository"],
    [direct, "project"],
    [direct, "channel"],
  ] as const) {
    const answer = await tools.call("notebook", add(kind, "canary-refused"));
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^notebook must be (channel|user)\.$/);
  }
  for (const [kind, id] of [
    ["repository", "acme/app"],
    ["project", "p1"],
    ["channel", "T1:C1"],
    ["user", "ann"],
  ] as const)
    expect((await readNotebook(db, { workspaceId: "W1", kind, id })).entries).toEqual([]);
});
