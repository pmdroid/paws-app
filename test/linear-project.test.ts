import { syncSteps } from "../src/runner-backend";
import { expect, test } from "bun:test";
import {
  applyLinearIssueProject,
  bindLinearSessionTask,
  migrate,
  openDatabase,
  recordLinearInstallation,
  sqliteDb,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import {
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  parseAgentEvent,
  parseLinearIssueProjectChange,
  type EpicSnapshot,
} from "../src/linear";
import { createLiveStatusProvider } from "../src/dashboard";

const at = Date.parse("2026-10-24T12:00:00.000Z");

function issue(project: { id: string; name: string } | null): EpicSnapshot {
  return {
    linearIssueId: "issue",
    identifier: "PAS-608",
    title: "Ship mise",
    description: null,
    teamId: "team",
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    subIssues: [],
  };
}

async function delegated(snapshot: EpicSnapshot) {
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([snapshot]);
  const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue", now: 1000 });
  if (!intake.ok) throw new Error("intake failed");
  const projectOf = async () =>
    (await createLiveStatusProvider(db).issues()).issues.find((item) => item.id === "PAS-608")
      ?.project;
  return { db, tracker, intake, projectOf };
}

function projectWebhook(data: Record<string, unknown>) {
  return parseAgentEvent(
    JSON.stringify({
      type: "Issue",
      action: "update",
      organizationId: "org",
      createdAt: new Date(at).toISOString(),
      data: { id: "issue", identifier: "PAS-608", ...data },
      updatedFrom: { projectId: "runtimes" },
    }),
    "delivery",
    at,
  )!;
}

test("an item delegated from a Linear project shows that project", async () => {
  const { db, projectOf } = await delegated(issue({ id: "runtimes", name: "Runner runtimes" }));
  expect(await projectOf()).toEqual({ id: "runtimes", name: "Runner runtimes" });
  db.close();
});

test("an item with no Linear project shows none", async () => {
  const { db, projectOf } = await delegated(issue(null));
  expect(await projectOf()).toBeNull();
  db.close();
});

test("an issue webhook that moves the issue to another project updates it", async () => {
  const { db, projectOf } = await delegated(issue({ id: "runtimes", name: "Runner runtimes" }));
  const moved = parseLinearIssueProjectChange(
    projectWebhook({ projectId: "linear", project: { id: "linear", name: "Linear projects" } }),
  );
  expect(moved).toEqual({
    issueId: "issue",
    organizationId: "org",
    project: { id: "linear", name: "Linear projects" },
  });
  await applyLinearIssueProject(sqliteDb(db), moved!.issueId, moved!.project);
  expect(await projectOf()).toEqual({ id: "linear", name: "Linear projects" });

  const removed = parseLinearIssueProjectChange(projectWebhook({ projectId: null }));
  expect(removed?.project).toBeNull();
  await applyLinearIssueProject(sqliteDb(db), removed!.issueId, removed!.project);
  expect(await projectOf()).toBeNull();
  db.close();
});

test("a webhook without a project change is not a project change", () => {
  const event = parseAgentEvent(
    JSON.stringify({
      type: "Issue",
      action: "update",
      organizationId: "org",
      data: { id: "issue", projectId: "runtimes" },
      updatedFrom: { title: "Old" },
    }),
    "delivery",
    at,
  )!;
  expect(parseLinearIssueProjectChange(event)).toBeNull();
});

test("a reconcile after the issue moved in Linear stores the new project", async () => {
  const { db, tracker, intake, projectOf } = await delegated(
    issue({ id: "runtimes", name: "Runner runtimes" }),
  );
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1000,
  });
  bindLinearSessionTask(db, "session", intake.delegation.id);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "issue",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: "app",
  });
  const reconciler = createItemReconciler({
    db,
    tracker,
    lifecycle,
    onChanges: () => syncSteps(() => {}),
  });
  const epic = tracker.epics.get("issue")!;
  epic.projectId = "linear";
  epic.projectName = "Linear projects";
  await reconciler.reconcile({ itemId: intake.items[0]!.id, workspaceId: "workspace" });
  expect(await projectOf()).toEqual({ id: "linear", name: "Linear projects" });
  await reconciler.close();
  db.close();
});
