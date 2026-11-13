import { appendFileSync } from "node:fs";
import { join } from "node:path";
import dirty from "./dirty-pull-ci-wait";
import { type Proof } from "./harness";

const rebasePrompts: string[] = [];

export default {
  covers: ["src/merge/orders.ts", "src/db/rebase-returns.ts"],
  summary:
    'With main_moved = "green", a DIRTY pull request goes back to rebase, and the rebase turn ends with the same head. It waits on the same main without a second return, and once main moves while it still conflicts it goes back again instead of waiting for CI that never runs.',
  ciPending: true,
  agent: (input) => {
    if (input.purpose === "implement" && input.prompt.includes("no longer rebases cleanly")) {
      rebasePrompts.push(input.prompt);
      return [];
    }
    return dirty.agent(input);
  },
  async run(proof) {
    appendFileSync(
      join(process.env.PAWS_HOME!, "config.toml"),
      '\n[merge]\nmain_moved = "green"\n',
    );
    await proof.delegate();
    await proof.waitFor(
      "Closeout accepts and the item waits in the merge queue on CI",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
    );
    proof.github.ci.pending = false;
    proof.github.ci.dirty = true;
    const accepted = async () =>
      (await proof.transitions()).filter((row) => row.event === "closeout_accepted").length;
    await proof.waitFor("the first rebase turn starts", () => rebasePrompts.length === 1, 60_000);
    await proof.waitFor(
      "the rebase turn ends with the same head and the item is back in the merge queue",
      async () => (await proof.itemState()) === "merge_queue" && (await accepted()) === 2,
      60_000,
    );
    await proof.waitFor("the lane polls on the same main", () => false, 3_000);
    proof.expect(
      "on the same main the head is not sent back a second time",
      rebasePrompts.length === 1 && (await proof.itemState()) === "merge_queue",
      { prompts: rebasePrompts.length, state: await proof.itemState() },
    );
    await proof.pushToMain("SHELVES.md", "# Shelves\n", "Document the acme widget shelves");
    await proof.waitFor("the second rebase turn starts", () => rebasePrompts.length === 2, 60_000);
    const restarts = (await proof.transitions()).filter(
      (row) => row.from === "merge_queue" && row.event === "restart",
    );
    proof.expect(
      "the same head conflicting with a newer main goes back to the agent again",
      restarts.length === 2 && rebasePrompts.length === 2,
      (await proof.transitions()).map((row) => row.event),
    );
    proof.expect(
      "the lane never squashed the conflicting pull request",
      !proof.github.calls.some((call) => call.method === "PUT" && call.path.endsWith("/merge")),
    );
  },
} satisfies Proof;
