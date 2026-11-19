import { join } from "node:path";
import { setJournalSink } from "../../src/journal";
import {
  currentSourceContextRecords,
  getContextSession,
  listWorkItemsByStates,
  type ContextNamespace,
} from "../../src/db";
import {
  MEMORY_INDEX_HEADER,
  MEMORY_INDEX_LIMITS,
  RECALL_LIMITS,
  RECALL_NO_ENTRY,
  createFakeContextAccess,
  createFakeProjectContextReads,
  createProjectContextHttp,
  createProjectSessionContext,
  estimateContextTokens,
  recordWorkItemContext,
  type ContextManifest,
  type ContextView,
  type ContextViewDetail,
  type RecallEntry,
} from "../../src/project-context";
import type { FakeStep } from "../../src/acp/testing/script";
import { ACME, ACME_B, type LaunchInput, type Proof, type ProofIssue } from "./harness";

const ORG = "org";
const PROJECT = "project-acme";
const PERSON = "acme-user";
const TEAM = { teamIds: ["team-a", "team-b"], repositories: [], channelIds: [] };

const FACT = "The warehouse report reads widgets.txt line by line; keep one count per line.";
const OPEN_QUESTION = "Nobody has said whether archived shelves belong in the shelf count.";
const FORGET_ME = "FORGOTTEN-FACT shelves on aisle 9 are counted twice.";
const SIBLING = "Shelf labels follow the A-12 aisle-number format.";
const LATE_FACT = "widgets.txt prints an empty shelf as 0.";
const QUESTION = "Should empty shelves count as 0 or be skipped?";
const ANSWERS = [
  "Skip them, the report hides empty rows.",
  "Count them as 0, because the warehouse report sums every shelf.",
];
const CANARIES = {
  otherProject: "CANARY-OTHER-PROJECT",
  otherOrg: "CANARY-OTHER-ORG",
  private: "CANARY-PRIVATE",
  revoked: "CANARY-REVOKED-AFTER-INDEX",
};
const AISLES = Array.from(
  { length: 16 },
  (_, n) =>
    `- Requirement: Aisle ${n + 1} reports its shelves in the order printed on the aisle ${n + 1} floor plan.`,
);

const access = createFakeContextAccess();
access.grant({ workspaceId: ORG, userId: PERSON }, TEAM);
access.grant({ workspaceId: ORG, userId: "dana" }, TEAM);
access.grant({ workspaceId: "org-b", userId: PERSON }, TEAM);
const reads = createFakeProjectContextReads();
reads.projects.set(PROJECT, {
  id: PROJECT,
  name: "Warehouse",
  url: `https://linear.app/acme/project/${PROJECT}`,
  revision: "2026-11-17T00:00:00.000Z",
  revisionAt: Date.parse("2026-11-17T00:00:00.000Z"),
  teamIds: ["team-a"],
  content: ["## Constraints", "- Requirement: Counts are whole numbers.", ...AISLES].join("\n"),
});
const namespace: ContextNamespace = {
  workspaceId: ORG,
  scopeKind: "linear_project",
  scopeId: PROJECT,
};
const requester = { workspaceId: ORG, userId: PERSON };
const http = (store: Parameters<typeof createProjectContextHttp>[0]["db"]) =>
  createProjectContextHttp({ db: store, access });

const ids = { decision: "", fact: "", revoked: "", forgotten: "" };

const remember = (operations: unknown[]): FakeStep => ({
  type: "host_tool",
  name: "remember",
  arguments: { operations },
});
const recall = (argument: { id: string } | { query: string }): FakeStep => ({
  type: "host_tool",
  name: "recall",
  arguments: argument,
});
const commit = (input: LaunchInput, file: string, content: string, message: string): FakeStep[] => [
  { type: "fs_write", path: join(input.worktree, file), content },
  { type: "terminal", command: "git", args: ["add", file], cwd: input.worktree },
  { type: "terminal", command: "git", args: ["commit", "-q", "-m", message], cwd: input.worktree },
];
const indexId = (prompt: string, text: string) =>
  prompt
    .split("\n")
    .find((line) => line.startsWith("- [") && line.includes(text))
    ?.match(/, id (\w+)\)$/)?.[1] ?? "";

function taskA(input: LaunchInput): FakeStep[] {
  if (input.prompt.includes(ANSWERS[1]!))
    return [
      remember([{ action: "add", kind: "fact", content: LATE_FACT }]),
      remember(
        Array.from({ length: 6 }, (_, n) => ({
          action: "add",
          kind: "fact",
          content: `extra ${n}`,
        })),
      ),
      remember([{ action: "add", kind: "decision", content: "Agents decide empty shelves." }]),
      ...commit(input, "widgets.txt", "12\n0\n", "Count empty shelves as 0"),
    ];
  if (input.prompt.includes(ANSWERS[0]!)) return [{ type: "ask_team", question: QUESTION }];
  return [
    remember([
      { action: "add", kind: "fact", content: FACT },
      { action: "add", kind: "open_question", content: OPEN_QUESTION },
      { action: "add", kind: "fact", content: FORGET_ME },
      { action: "add", kind: "fact", content: SIBLING },
    ]),
    remember([{ action: "add", kind: "fact", content: FACT }]),
    { type: "ask_team", question: QUESTION },
  ];
}

function taskB(input: LaunchInput): FakeStep[] {
  ids.decision = indexId(input.prompt, QUESTION);
  ids.fact = indexId(input.prompt, "widgets.txt line by line");
  ids.revoked = indexId(input.prompt, CANARIES.revoked);
  access.grant(requester, { ...TEAM, teamIds: ["team-a"] });
  return [
    recall({ id: ids.decision }),
    recall({ id: ids.fact }),
    recall({ id: ids.revoked }),
    recall({ id: ids.forgotten }),
    recall({ query: "archived shelves count" }),
    recall({ query: "whole numbers" }),
    ...commit(input, "empty.txt", "0\n", "Report empty shelves"),
  ];
}

export default {
  covers: [
    "src/project-context/**",
    "src/db/project-context*.ts",
    "src/loop/orchestrator.ts",
    "src/acp/host-tools*.ts",
    "test/proofs/harness.ts",
  ],
  summary:
    "Task ACME-7's agent saves facts and an open question with remember, asks ask_team and gets a person's answer, then a correction. A person forgets one fact in the Context view and Paws restarts on the same database. Task ACME-8 in the same project then starts: its first prompt carries the memory index with the corrected decision, ids and sources, and its agent reads them back with recall by id and by query. Forgotten, outdated, other-project, private and revoked entries never reach it, and nothing about memory is written to Linear.",
  config: "\n[project_memory]\ndecisions = true\ndream = false\n",
  secondIssue: true,
  delegatePayload: { organizationId: ORG, agentSession: { creatorId: PERSON } },
  linearProject: { id: PROJECT, name: "Warehouse" },
  projectContext: (store) =>
    createProjectSessionContext({ db: store, access, reads, memoryIndex: true }),
  agent: (input) =>
    input.purpose !== "implement"
      ? []
      : input.worktree.includes(ACME_B.identifier)
        ? taskB(input)
        : taskA(input),
  async run(proof) {
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      for (const issue of [ACME.issueId, ACME_B.issueId])
        proof.linear.mergeContexts.set(issue, { projectId: PROJECT, labels: [] });
      await proof.delegate();
      const asked = (count: number) =>
        proof.waitFor(
          `ACME-7's question ${count} is open`,
          async () =>
            (await proof.itemState(ACME)) === "awaiting_input" &&
            proof.linear.questions.length >= count,
          60_000,
        );
      const done = (issue: ProofIssue) =>
        proof.waitFor(
          `${issue.identifier} is merged`,
          async () =>
            ["merged", "failed", "manual", "cancelled"].includes(
              (await proof.itemState(issue)) ?? "",
            ),
          120_000,
        );
      const workItemId = async (issueId: string) =>
        (await listWorkItemsByStates(proof.store, ["merged", "awaiting_input", "running"])).find(
          (item) => item.linearIssueId === issueId,
        )?.id ?? "";
      const stored = async () =>
        currentSourceContextRecords(
          proof.store,
          namespace,
          { kind: "paws_work_item", id: await workItemId(ACME.issueId) },
          Date.now(),
        );

      await asked(1);
      const firstA = proof.launches.find((launch) => launch.purpose === "implement")!;
      const firstResults = proof.toolResults(firstA);
      const afterRemember = await stored();
      proof.expect(
        "task A's agent saved facts and an open question through remember, and the repeated call kept one copy",
        firstResults.length === 2 &&
          firstResults.every((result) => result.ok) &&
          afterRemember.filter((row) => row.body === FACT).length === 1 &&
          afterRemember.length === 4 &&
          afterRemember.some(
            (row) => row.classification === "unresolved_question" && row.body === OPEN_QUESTION,
          ),
        { results: firstResults, rows: afterRemember.map((row) => [row.classification, row.body]) },
      );

      await proof.answerInLinear(ANSWERS[0]!);
      await asked(2);
      const decided = (await stored()).filter((row) => row.classification === "decision");
      await proof.answerInLinear(ANSWERS[1]!);
      const mergedA = await done(ACME);
      const rowsA = await stored();
      const decisions = rowsA.filter((row) => row.classification === "decision");
      proof.expect(
        "the person's answer became one decision, and the re-asked question's answer corrected it",
        decided.length === 1 &&
          decided[0]!.body.includes(ANSWERS[0]!) &&
          decisions.length === 1 &&
          decisions[0]!.supersedes === decided[0]!.id &&
          decisions[0]!.body.startsWith(`${QUESTION} → ${ANSWERS[1]}`) &&
          decisions[0]!.actorId === PERSON,
        decisions.map((row) => ({
          body: row.body,
          actor: row.actorId,
          supersedes: row.supersedes,
        })),
      );
      const lastA = proof.launches.filter((launch) => launch.purpose === "implement").at(-1)!;
      const refused = proof.toolResults(lastA);
      proof.expect(
        "a later remember call saves, while six operations in one call and an agent decision are refused and change nothing",
        refused.length === 3 &&
          refused[0]!.ok &&
          refused.slice(1).every((result) => !result.ok) &&
          rowsA.length === 6 &&
          !rowsA.some((row) => row.body.includes("extra ") || row.body.includes("Agents decide")),
        refused,
      );
      proof.expect(
        "the reviewer got neither remember nor recall",
        proof.launches
          .filter((launch) => launch.role === "reviewer")
          .every(
            (launch) =>
              !proof.hostTools(launch).includes("remember") &&
              !proof.hostTools(launch).includes("recall"),
          ),
        proof.launches.map((launch) => [launch.purpose, launch.role, proof.hostTools(launch)]),
      );
      proof.expect("ACME-7 merged", mergedA && (await proof.itemState(ACME)) === "merged");

      const viewFor = async () => {
        const response = await http(proof.store)(
          new Request(`http://127.0.0.1/api/context/project/${PROJECT}`),
          requester,
          async () => true,
        );
        return ((await response!.json()) as { view: ContextView }).view;
      };
      const view = await viewFor();
      const shown = [...view.decisions, ...view.questions, ...view.records];
      const labelOf = (text: string) => shown.find((record) => record.text.includes(text));
      proof.expect(
        "the Context view labels the agent's entries and the person's answer by ACME-7",
        labelOf(FACT)?.source.label === `Agent on ${ACME.identifier}` &&
          labelOf(LATE_FACT)?.source.label === `Agent on ${ACME.identifier}` &&
          labelOf(OPEN_QUESTION)?.source.label === `Agent on ${ACME.identifier}` &&
          labelOf(OPEN_QUESTION)?.classification === "unresolved_question" &&
          view.decisions.length === 1 &&
          view.decisions[0]!.source.label === `Work item memory on ${ACME.identifier}` &&
          view.decisions[0]!.corrected === true &&
          labelOf(FORGET_ME)?.forgettable === true,
        shown.map((record) => [
          record.classification,
          record.source.label,
          record.text.slice(0, 40),
        ]),
      );
      const detailResponse = await http(proof.store)(
        new Request(
          `http://127.0.0.1/api/context/project/${PROJECT}/records/${view.decisions[0]!.id}`,
        ),
        requester,
        async () => true,
      );
      const detail = ((await detailResponse!.json()) as { detail: ContextViewDetail }).detail;
      proof.expect(
        "the decision's detail names the person who answered and keeps both versions",
        detail.record.actorId === PERSON && detail.versions.length === 2,
        { actor: detail.record.actorId, versions: detail.versions.length },
      );

      ids.forgotten = labelOf(FORGET_ME)!.id;
      act("Forget the aisle 9 fact on the Context page");
      const forgot = await http(proof.store)(
        new Request(
          `http://127.0.0.1/api/context/project/${PROJECT}/records/${ids.forgotten}/forget`,
          { method: "POST" },
        ),
        requester,
        async () => true,
      );
      proof.expect("the Forget button forgot the entry", forgot?.status === 200, forgot?.status);

      const canary = (scope: ContextNamespace, id: string, body: string, restriction: object) =>
        recordWorkItemContext(proof.store, access, {
          namespace: scope,
          requester: { workspaceId: scope.workspaceId, userId: PERSON },
          workItemId: id,
          revision: "c1",
          revisionAt: Date.now(),
          restriction,
          entries: [{ classification: "decision", body }],
          now: Date.now(),
        });
      await canary(
        { ...namespace, scopeId: "project-other" },
        "canary-project",
        CANARIES.otherProject,
        {
          teamIds: ["team-a"],
        },
      );
      await canary({ ...namespace, workspaceId: "org-b" }, "canary-org", CANARIES.otherOrg, {
        teamIds: ["team-a"],
      });
      await recordWorkItemContext(proof.store, access, {
        namespace,
        requester: { workspaceId: ORG, userId: "dana" },
        workItemId: "canary-private",
        revision: "c1",
        revisionAt: Date.now(),
        restriction: { teamIds: ["team-a"], userId: "dana" },
        entries: [{ classification: "decision", body: CANARIES.private }],
        now: Date.now(),
      });
      await canary(namespace, "canary-revoked", CANARIES.revoked, { teamIds: ["team-b"] });

      await proof.restart();
      const replayed = await stored();
      proof.expect(
        "after the restart the same current entries are there, minus the forgotten one",
        replayed.length === 5 &&
          !replayed.some((row) => row.body === FORGET_ME) &&
          replayed.some((row) => row.body === SIBLING),
        replayed.map((row) => row.body.slice(0, 40)),
      );

      const heldBefore = await proof.heldWork();
      const launchesBefore = proof.launches.length;
      await proof.delegate(ACME_B);
      const mergedB = await done(ACME_B);
      const firstB = proof.launches
        .slice(launchesBefore)
        .find((launch) => launch.purpose === "implement");
      const prompt = firstB?.prompt ?? "";
      const index = prompt.slice(
        prompt.indexOf(MEMORY_INDEX_HEADER),
        prompt.indexOf("\n\n", prompt.indexOf(MEMORY_INDEX_HEADER)),
      );
      proof.expect(
        "task B's first prompt carries the memory index with the corrected decision, its id and its ACME-7 source",
        index.startsWith(MEMORY_INDEX_HEADER) &&
          index.includes(`${QUESTION} → ${ANSWERS[1]}`) &&
          !index.includes(ANSWERS[0]!) &&
          ids.decision !== "" &&
          index.includes(`paws_work_item ${await workItemId(ACME.issueId)}@answer-`) &&
          index.includes(`paws_work_item ${await workItemId(ACME.issueId)}@remember-`),
        index,
      );
      proof.expect(
        "the index stays inside its token budget and says how many more entries recall can reach",
        estimateContextTokens(index) <= MEMORY_INDEX_LIMITS.tokens &&
          /\d+ more entries: use recall\(\{query\}\)\./.test(index),
        { tokens: estimateContextTokens(index), budget: MEMORY_INDEX_LIMITS.tokens },
      );
      const results = firstB ? proof.toolResults(firstB) : [];
      const parse = (text = "") => {
        try {
          return JSON.parse(text) as RecallEntry | RecallEntry[];
        } catch {
          return text;
        }
      };
      const [byDecision, byFact, byRevoked, byForgotten, byQuestion, byAisle] = results.map(
        (result) => parse(result.text),
      );
      proof.expect(
        "recall by id returns the corrected decision and the agent's fact, with their ACME-7 source",
        (byDecision as RecallEntry).classification === "decision" &&
          (byDecision as RecallEntry).body.startsWith(`${QUESTION} → ${ANSWERS[1]}`) &&
          (byDecision as RecallEntry).source.kind === "paws_work_item" &&
          (byFact as RecallEntry).body === FACT &&
          (byFact as RecallEntry).source.revision.startsWith("remember-"),
        { byDecision, byFact },
      );
      proof.expect(
        "recall by id refuses the forgotten entry and the one whose access was revoked after indexing",
        ids.revoked !== "" && byRevoked === RECALL_NO_ENTRY && byForgotten === RECALL_NO_ENTRY,
        { byRevoked, byForgotten, revokedInIndex: ids.revoked },
      );
      const asList = (value: unknown) => (Array.isArray(value) ? (value as RecallEntry[]) : []);
      proof.expect(
        "recall by query finds the open question and an aisle the index left out, within the recall budget",
        asList(byQuestion).some(
          (entry) => entry.classification === "unresolved_question" && entry.body === OPEN_QUESTION,
        ) &&
          !index.includes("Counts are whole numbers") &&
          asList(byAisle).some((entry) => entry.body === "Counts are whole numbers.") &&
          [byQuestion, byAisle].every(
            (found) =>
              asList(found).length <= RECALL_LIMITS.entries &&
              estimateContextTokens(
                asList(found)
                  .map((entry) => entry.body)
                  .join("\n"),
              ) <= RECALL_LIMITS.tokens,
          ),
        {
          byQuestion: asList(byQuestion).map((entry) => entry.body.slice(0, 50)),
          byAisle: asList(byAisle).map((entry) => entry.body.slice(0, 50)),
        },
      );
      const everything = JSON.stringify([prompt, results]);
      const leaked = [
        ...Object.values(CANARIES).filter((text) => text !== CANARIES.revoked),
        "FORGOTTEN-FACT",
        "canary-private",
        "canary-project",
        "canary-org",
      ].filter((text) => everything.includes(text));
      proof.expect(
        "no forgotten, outdated, other-project, other-workspace or private entry reached task B",
        leaked.length === 0 &&
          !everything.includes(ANSWERS[0]!) &&
          !JSON.stringify(results).includes(CANARIES.revoked),
        leaked,
      );
      proof.expect(
        "the unrelated sibling entry is still in the project's memory for task B",
        prompt.includes(SIBLING) || everything.includes(SIBLING),
        null,
      );
      const session = await getContextSession(
        proof.store,
        `work_item:${await workItemId(ACME_B.issueId)}`,
      );
      const manifest = session?.manifest as ContextManifest | undefined;
      proof.expect(
        "task B's stored manifest lists the indexed entries within the memory budget",
        session?.status === "injected" &&
          manifest !== undefined &&
          manifest.tokens.memoryUsed <= manifest.tokens.memoryBudget &&
          manifest.tokens.total <= manifest.tokens.hardCap &&
          manifest.sources.some((source) => JSON.stringify(source).includes(ids.decision)),
        { tokens: manifest?.tokens, sources: manifest?.sources.length },
      );
      proof.expect(
        "task B ran on its own one run, and memory added no run, reservation or job",
        heldBefore.activeRuns === 0 &&
          heldBefore.reservations === 0 &&
          proof.launches.slice(launchesBefore).filter((launch) => launch.purpose === "implement")
            .length === 1,
        heldBefore,
      );
      const linear = JSON.stringify([
        proof.linear.progress,
        proof.linear.questions,
        proof.linear.statuses,
        proof.linear.sessionUpdates,
        proof.linear.attachments,
      ]);
      proof.expect(
        "nothing remembered was copied to Linear, and no issue was filed",
        ![FACT, OPEN_QUESTION, SIBLING, FORGET_ME, ...Object.values(CANARIES)].some((text) =>
          linear.includes(text),
        ) &&
          proof.linear.subIssueRequests.length === 0 &&
          proof.linear.findingIssueRequests.length === 0 &&
          reads.calls.every((call) => call.kind === "project" || call.kind === "documents"),
        { subIssues: proof.linear.subIssueRequests.length },
      );
      proof.expect(
        "no decision recording failed",
        !lines.some((line) => line.includes("operation=orchestrator.recordDecision")),
        lines.filter((line) => line.includes("recordDecision")),
      );
      proof.expect("ACME-8 merged", mergedB && (await proof.itemState(ACME_B)) === "merged");
    } finally {
      restore();
    }
  },
} satisfies Proof;

function act(action: string) {
  console.log(`ACT ${action}`);
}
