import { join } from "node:path";
import { getContextSession, listWorkItemsByStates, type ContextNamespace } from "../../src/db";
import {
  CONTEXT_PACK_HEADER,
  createFakeContextAccess,
  createFakeProjectContextReads,
  createProjectSessionContext,
  forgetContextSource,
  recordWorkItemContext,
  type ProjectSessionContext,
} from "../../src/project-context";
import { ACME, type Proof } from "./harness";

const ORG = "org";
const PROJECT = "project-acme";
const CREATOR = "acme-user";
const DECISION = "Shelves count empty slots as 0";
const REASON = "the warehouse report sums every shelf";
const QUESTION = "Do archived shelves belong in the count";
const APPROVAL = "Approved: merge without Closeout";
const CANARIES = ["CANARY-OTHER-PROJECT", "CANARY-OTHER-ORG", "CANARY-PRIVATE", "CANARY-CHANNEL"];

const access = createFakeContextAccess();
access.grant(
  { workspaceId: ORG, userId: CREATOR },
  { teamIds: ["team-a"], repositories: [], channelIds: [] },
);
const reads = createFakeProjectContextReads();
reads.projects.set(PROJECT, {
  id: PROJECT,
  name: "Warehouse",
  url: `https://linear.app/acme/project/${PROJECT}`,
  revision: "2026-11-17T00:00:00.000Z",
  revisionAt: Date.parse("2026-11-17T00:00:00.000Z"),
  teamIds: ["team-a"],
  content: "## Constraints\n- Requirement: Counts are whole numbers.",
});
reads.documents.set("doc-forgotten", {
  id: "doc-forgotten",
  projectId: PROJECT,
  title: "Old plan",
  url: "https://linear.app/acme/document/doc-forgotten",
  revision: "2026-11-16T00:00:00.000Z",
  revisionAt: Date.parse("2026-11-16T00:00:00.000Z"),
  creatorId: CREATOR,
  content: "## Decisions\n- Decision: FORGOTTEN-DOC shelves are counted by hand.",
});
const services: ProjectSessionContext[] = [];

const namespace: ContextNamespace = {
  workspaceId: ORG,
  scopeKind: "linear_project",
  scopeId: PROJECT,
};

export default {
  covers: [
    "src/project-context/**",
    "src/db/project-context*.ts",
    "src/core/brief-template.ts",
    "src/linear/project-scope.ts",
  ],
  summary:
    "An earlier project session records a decision, its reason and an open question, and context preparation still works without runner capacity; a work item in the same project then gets Linear's project overview in its brief instead of a memory pack or index, stores no context session, and writes nothing to Linear.",
  delegatePayload: { organizationId: ORG, agentSession: { creatorId: CREATOR } },
  projectContext: (store) => {
    const service = createProjectSessionContext({ db: store, access, reads });
    services.push(service);
    return service;
  },
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
          { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
          {
            type: "terminal",
            command: "git",
            args: ["commit", "-q", "-m", "Count widgets per shelf"],
            cwd: input.worktree,
          },
        ]
      : [],
  async run(proof) {
    const now = Date.now();
    const requester = { workspaceId: ORG, userId: CREATOR };
    const sessionA = await recordWorkItemContext(proof.store, access, {
      namespace,
      requester,
      workItemId: "work-item-session-a",
      revision: "a1",
      revisionAt: now - 60_000,
      restriction: { teamIds: ["team-a"] },
      entries: [
        { classification: "decision", body: DECISION, reason: REASON },
        { classification: "unresolved_question", body: QUESTION },
        { classification: "decision", body: APPROVAL },
      ],
      now: now - 60_000,
    });
    const record = (scope: ContextNamespace, id: string, body: string, userId?: string) =>
      recordWorkItemContext(proof.store, access, {
        namespace: scope,
        requester: { workspaceId: scope.workspaceId, userId: userId ?? CREATOR },
        workItemId: id,
        revision: "c1",
        revisionAt: now - 60_000,
        restriction: { teamIds: ["team-a"], ...(userId ? { userId } : {}) },
        entries: [{ classification: "decision", body }],
        now: now - 60_000,
      });
    access.grant(
      { workspaceId: "org-b", userId: CREATOR },
      { teamIds: ["team-a"], repositories: [], channelIds: [] },
    );
    await record({ ...namespace, scopeId: "project-other" }, "canary-1", CANARIES[0]!);
    await record({ ...namespace, workspaceId: "org-b" }, "canary-2", CANARIES[1]!);
    access.grant(
      { workspaceId: ORG, userId: "dana" },
      { teamIds: ["team-a"], repositories: [], channelIds: [] },
    );
    await record(namespace, "canary-private-source", CANARIES[2]!, "dana");
    await recordWorkItemContext(proof.store, access, {
      namespace: { workspaceId: ORG, scopeKind: "slack_channel", scopeId: "C1" },
      requester,
      workItemId: "canary-4",
      revision: "c1",
      revisionAt: now - 60_000,
      restriction: { channelId: "C1" },
      entries: [{ classification: "decision", body: CANARIES[3]! }],
      now: now - 60_000,
    });
    proof.expect(
      "session A stored its decision and question",
      sessionA.status === "stored",
      sessionA,
    );

    const preview = await services[0]!.prepare({
      consumerKey: "preview:ACME-7",
      organizationId: ORG,
      projectId: PROJECT,
      requesterId: CREATOR,
      instructions: "",
      request: "Count widgets per shelf",
    });
    const held = await proof.heldWork();
    proof.expect(
      "context preparation works with no runner, run, reservation or job",
      preview.status === "injected" &&
        proof.launches.length === 0 &&
        held.activeRuns === 0 &&
        held.reservations === 0 &&
        held.runningJobs === 0,
      { status: preview.status, held, launches: proof.launches.length },
    );

    const forgotten = await forgetContextSource(proof.store, access, {
      namespace,
      requester,
      source: { kind: "linear_project_document", id: "doc-forgotten" },
      now: Date.now(),
    });
    proof.expect(
      "the old plan was read into context, then forgotten",
      preview.text.includes("FORGOTTEN-DOC") && forgotten.status === "forgotten",
      forgotten.status,
    );

    proof.linear.mergeContexts.set(ACME.issueId, {
      projectId: PROJECT,
      labels: [],
      overview: {
        name: "Warehouse",
        content: "Requirement: Counts are whole numbers.",
        documents: [
          { title: "Old plan", content: "Decision: FORGOTTEN-DOC shelves are counted by hand." },
        ],
      },
    });
    await proof.delegate();
    const merged = await proof.waitFor(
      "the item is merged",
      async () =>
        ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);

    const first = proof.launches.find((launch) => launch.purpose === "implement");
    const prompt = first?.prompt ?? "";
    proof.expect(
      "session B's first turn gets Linear's project overview and no memory pack, index or decision",
      prompt.includes("Project overview: Warehouse\n\nRequirement: Counts are whole numbers.") &&
        prompt.indexOf("Write the shelf count to widgets.txt.") <
          prompt.indexOf("Project overview: Warehouse") &&
        !prompt.includes(CONTEXT_PACK_HEADER) &&
        !prompt.includes("Project memory index") &&
        !prompt.includes("recall(") &&
        !prompt.includes(DECISION) &&
        !prompt.includes(QUESTION),
      prompt.slice(0, 1_500),
    );
    proof.expect(
      "no turn gets remember or recall, and the work turn's prompt never asks for `remember`",
      first !== undefined &&
        !prompt.includes("`remember`") &&
        proof.launches.every(
          (launch) =>
            !proof.hostTools(launch).includes("remember") &&
            !proof.hostTools(launch).includes("recall"),
        ),
      proof.launches.map((launch) => [launch.purpose, proof.hostTools(launch)]),
    );
    const leaked = CANARIES.filter((canary) => prompt.includes(canary));
    proof.expect(
      "no other project, workspace, private source or channel canary reached the prompt",
      leaked.length === 0 && !prompt.includes("canary-private-source"),
      leaked,
    );
    const [item] = await listWorkItemsByStates(proof.store, ["merged"]);
    const session = item ? await getContextSession(proof.store, `work_item:${item.id}`) : null;
    proof.expect("no context session is stored for the work item", !!item && session === null, {
      status: session?.status,
    });
    const posted = JSON.stringify([
      proof.linear.progress,
      proof.linear.questions,
      proof.linear.statuses,
      proof.linear.sessionUpdates,
    ]);
    proof.expect(
      "nothing from the context was copied to Linear, and no issue or question was created",
      !posted.includes(DECISION) &&
        !posted.includes(QUESTION) &&
        proof.linear.subIssueRequests.length === 0 &&
        proof.linear.questions.length === 0 &&
        proof.linear.issueSessions.length === 0,
      { subIssues: proof.linear.subIssueRequests.length, questions: proof.linear.questions.length },
    );
    const transitions = await proof.transitions();
    proof.expect(
      "the remembered approval did not skip Closeout or start another run",
      transitions.some((row) => row.event === "closeout_accepted") &&
        proof.launches.filter((launch) => launch.purpose === "implement").length === 1 &&
        (await listWorkItemsByStates(proof.store, ["merged", "queued", "running"])).length === 1,
      transitions.map((row) => row.event),
    );
    proof.expect(
      "the Linear project read stayed read-only",
      reads.calls.every((call) => call.kind === "project" || call.kind === "documents"),
      reads.calls,
    );
    proof.expect(
      "the item merged",
      merged && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
