import type { Proof } from "./harness";

export default {
  covers: [
    "src/closeout/**",
    "src/db/items.ts",
    "src/loop/orchestrator.ts",
    "src/loop/turn-passes.ts",
    "src/runner-worker/**",
    "src/runner-backend/**",
  ],
  summary: "An agent turn that changes no file and makes no commit does not fail the item.",
  agent: () => [
    {
      type: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Widgets are already counted per shelf; nothing to change.",
        },
      },
    },
  ],
  async run(proof) {
    await proof.delegate();
    const settled = await proof.waitFor(
      "the turn ends and the item settles",
      () => !["queued", "running", "verifying", "recovering"].includes(proof.itemState() ?? ""),
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    proof.expect("the item settles after the turn", settled, proof.itemState());
    proof.expect("the item is not failed", proof.itemState() !== "failed", proof.itemState());
    proof.expect(
      "the implementer turn ran",
      proof.launches.some((launch) => launch.purpose === "implement"),
      proof.launches.map((launch) => launch.purpose),
    );
  },
} satisfies Proof;
