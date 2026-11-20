import { expect, test } from "bun:test";
import {
  beginImplementRun,
  bindWorkItemRepository,
  insertQueuedItem,
  listOutbox,
  recordItemCandidate,
} from "../db";
import { tempStore } from "../../test/pglite";
import { acceptGitHubDelivery } from "./merge-jobs";
import type { PullCommentFilter } from "./pull-comments";

const filter: PullCommentFilter = {
  appId: async () => "1",
  appLogin: () => "paws-app[bot]",
  ignoredBots: () => [],
  ignoredMarkers: () => [],
};

async function setup(running: boolean) {
  const store = await tempStore();
  await insertQueuedItem(store.db, { id: "eng-1", sessionKey: "ses-1", now: 1_000 });
  await bindWorkItemRepository(store.db, "eng-1", {
    owner: "acme",
    repo: "one",
    remoteUrl: "https://github.com/acme/one.git",
  });
  await recordItemCandidate(store.db, {
    itemId: "eng-1",
    sha: "paws-head",
    branch: "paws/eng-1",
    recordedAt: 1_000,
  });
  if (running) await beginImplementRun(store.db, "eng-1", 1_000);
  return store;
}

function delivery(
  id: string,
  head: string,
  sender: { login: string; type: string } = { login: "octo", type: "User" },
  action = "synchronize",
) {
  return {
    deliveryId: id,
    event: "pull_request",
    payload: JSON.stringify({
      action,
      sender,
      repository: { name: "one", full_name: "acme/one", owner: { login: "acme" } },
      pull_request: {
        head: { ref: "paws/eng-1", sha: head, repo: { full_name: "acme/one" } },
      },
    }),
  };
}

async function thoughts(store: Awaited<ReturnType<typeof setup>>) {
  return (await listOutbox(store.db, "ses-1")).filter((row) =>
    row.idempotencyKey.startsWith("outside-push:"),
  );
}

test("an outside push posts one thought and one follow-up to a running item, also after redelivery", async () => {
  const store = await setup(true);
  const followUps: [string, string][] = [];
  const followUp = (itemId: string, body: string) => {
    followUps.push([itemId, body]);
    return true;
  };
  try {
    await acceptGitHubDelivery(store.db, delivery("d-1", "their-head"), 2_000, filter, followUp);
    await acceptGitHubDelivery(store.db, delivery("d-1", "their-head"), 2_100, filter, followUp);
    await acceptGitHubDelivery(store.db, delivery("d-2", "their-head"), 2_200, filter, followUp);
    const rows = await thoughts(store);
    expect(rows.map((row) => row.idempotencyKey)).toEqual(["outside-push:eng-1:their-head"]);
    expect(rows[0]!.payload).toMatchObject({
      sessionId: "ses-1",
      kind: "thought",
      body: "octo pushed to paws/eng-1; Paws keeps these commits.",
    });
    expect(followUps).toEqual([
      [
        "eng-1",
        "octo pushed commits to paws/eng-1 while you work. Before you commit again, run git pull --rebase origin paws/eng-1 and keep their changes.",
      ],
    ]);
  } finally {
    await store.close();
  }
});

test("an outside push to an item that is not running posts only the thought", async () => {
  const store = await setup(false);
  const followUps: string[] = [];
  try {
    await acceptGitHubDelivery(store.db, delivery("d-1", "their-head"), 2_000, filter, (id) => {
      followUps.push(id);
      return true;
    });
    expect(await thoughts(store)).toHaveLength(1);
    expect(followUps).toEqual([]);
  } finally {
    await store.close();
  }
});

test("the candidate head, the Paws app's own push and other actions are not outside pushes", async () => {
  const store = await setup(true);
  const followUps: string[] = [];
  const followUp = (id: string) => {
    followUps.push(id);
    return true;
  };
  try {
    await acceptGitHubDelivery(store.db, delivery("d-1", "paws-head"), 2_000, filter, followUp);
    await acceptGitHubDelivery(
      store.db,
      delivery("d-2", "app-head", { login: "paws-app[bot]", type: "Bot" }),
      2_000,
      filter,
      followUp,
    );
    await acceptGitHubDelivery(
      store.db,
      delivery("d-3", "other-head", undefined, "opened"),
      2_000,
      filter,
      followUp,
    );
    expect(await thoughts(store)).toEqual([]);
    expect(followUps).toEqual([]);
  } finally {
    await store.close();
  }
});
