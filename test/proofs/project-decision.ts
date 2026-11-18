import { join } from "node:path";
import { setJournalSink } from "../../src/journal";
import {
  currentSourceContextRecords,
  listWorkItemsByStates,
  type ContextNamespace,
} from "../../src/db";
import {
  createFakeContextAccess,
  createFakeProjectContextReads,
  createProjectSessionContext,
} from "../../src/project-context";
import { ACME, type Proof } from "./harness";

const ORG = "org";
const PROJECT = "project-acme";
const ANSWERER = "acme-user";
const QUESTION = "Should empty shelves count as 0 or be skipped?";
const ANSWERS = ["Skip them.", "Count them as 0.", "Count them as 0, and say so in the report."];
const TEAM = { teamIds: ["team-a"], repositories: [], channelIds: [] };

const access = createFakeContextAccess();
access.grant({ workspaceId: ORG, userId: ANSWERER }, TEAM);
const reads = createFakeProjectContextReads();
reads.projects.set(PROJECT, {
  id: PROJECT,
  name: "Warehouse",
  url: `https://linear.app/acme/project/${PROJECT}`,
  revision: "2026-11-17T00:00:00.000Z",
  revisionAt: Date.parse("2026-11-17T00:00:00.000Z"),
  teamIds: ["team-a"],
  content: "Counts are whole numbers.",
});
let service: ReturnType<typeof createProjectSessionContext>;
const namespace: ContextNamespace = {
  workspaceId: ORG,
  scopeKind: "linear_project",
  scopeId: PROJECT,
};

export default {
  covers: [
    "src/project-context/decision.ts",
    "src/project-context/session.ts",
    "src/questions/store.ts",
    "src/loop/orchestrator.ts",
  ],
  summary:
    "The agent asks the same ask_team question three times. The first answer arrives while the answerer's project access can't be checked: Paws journals it, stores nothing and resumes the agent. The second answer is stored as one project decision with the answerer as actor, the third corrects it, and a later session in the project receives the decision.",
  delegatePayload: { organizationId: ORG, agentSession: { creatorId: ANSWERER } },
  projectContext: (store) => (service = createProjectSessionContext({ db: store, access, reads })),
  agent: (input) =>
    input.purpose !== "implement"
      ? []
      : !input.prompt.includes(ANSWERS[2]!)
        ? [{ type: "ask_team", question: QUESTION }]
        : [
            { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n0\n" },
            { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
            {
              type: "terminal",
              command: "git",
              args: ["commit", "-q", "-m", "Count empty shelves as 0"],
              cwd: input.worktree,
            },
          ],
  async run(proof) {
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      proof.linear.mergeContexts.set(ACME.issueId, { projectId: PROJECT, labels: [] });
      await proof.delegate();
      const decisions = async () => {
        const [item] = await listWorkItemsByStates(proof.store, ["awaiting_input", "merged"]);
        if (!item) return [];
        const rows = await currentSourceContextRecords(
          proof.store,
          namespace,
          { kind: "paws_work_item", id: item.id },
          Date.now(),
        );
        return rows.filter((row) => row.classification === "decision");
      };
      const asked = (count: number) =>
        proof.waitFor(
          `question ${count} is open`,
          async () =>
            (await proof.itemState()) === "awaiting_input" &&
            proof.linear.questions.length >= count,
          60_000,
        );

      await asked(1);
      access.grants.set(
        `${ORG}\0${ANSWERER}`,
        new Error("Linear membership could not be verified."),
      );
      await proof.answerInLinear(ANSWERS[0]!);
      const resumed = await asked(2);
      proof.expect(
        "a failed access check journals one line, stores nothing and doesn't block the answer",
        resumed &&
          lines.filter((line) => line.includes("operation=orchestrator.recordDecision")).length ===
            1 &&
          (await decisions()).length === 0,
        lines.filter((line) => line.includes("recordDecision")),
      );

      access.grant({ workspaceId: ORG, userId: ANSWERER }, TEAM);
      await proof.answerInLinear(ANSWERS[1]!);
      await asked(3);
      const first = await decisions();
      proof.expect(
        "the answer is stored as one decision with the answerer as actor",
        first.length === 1 &&
          first[0]!.actorId === ANSWERER &&
          first[0]!.body ===
            `${QUESTION} → ${ANSWERS[1]} Reason: Answered by ${ANSWERER} on ${ACME.identifier}`,
        first.map((row) => ({ body: row.body, actor: row.actorId })),
      );

      await proof.answerInLinear(ANSWERS[2]!);
      const merged = await proof.waitFor(
        "the item is merged",
        async () =>
          ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
        120_000,
      );
      const corrected = await decisions();
      proof.expect(
        "the re-answer corrects the entry instead of adding a second one",
        corrected.length === 1 &&
          corrected[0]!.supersedes === first[0]?.id &&
          corrected[0]!.body.includes(ANSWERS[2]!),
        corrected.map((row) => row.body),
      );

      const next = await service.prepare({
        consumerKey: "work_item:next-session",
        organizationId: ORG,
        projectId: PROJECT,
        requesterId: ANSWERER,
        instructions: "",
        request: "Report empty shelves",
      });
      proof.expect(
        "the next session in the project receives the decision",
        next.status === "injected" && next.text.includes(`${QUESTION} → ${ANSWERS[2]}`),
        next.status,
      );
      proof.expect(
        "the item merged",
        merged && (await proof.itemState()) === "merged",
        await proof.itemState(),
      );
    } finally {
      restore();
    }
  },
} satisfies Proof;
