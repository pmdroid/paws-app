import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "../src/acp";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  getLinearSessionGeneration,
  getWorkItemRepository,
  migrate,
  openDatabase,
  taskRequiresRepository,
} from "../src/db";
import {
  createFakeTracker,
  createLinearFileTransfer,
  type AcceptedLinearEvent,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { tempHome } from "./helpers";

test.each(["answer", "artifact", "clarify", "repository_choice", "repository_freeform"] as const)(
  "repository-backed %s survives restart and uses source without publishing code",
  async (scenario) => {
    const mode = scenario === "artifact" ? "artifact" : "answer";
    const repositoryChoice = scenario.startsWith("repository_");
    const home = tempHome();
    const root = join(home, "paws");
    const source = join(home, "source");
    mkdirSync(root);
    await git(["init", "-b", "main", source]);
    writeFileSync(join(source, "app.txt"), "Application source");
    await git(["-C", source, "add", "."]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Paws Test",
      "-c",
      "user.email=paws@example.com",
      "commit",
      "-m",
      "Seed",
    ]);
    const initialHead = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    const dbPath = join(root, "paws.db");
    let db = openDatabase(dbPath);
    migrate(db);
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-1",
        title: "Explain or screenshot this repository",
        description: null,
        subIssues: [],
      },
    ]);
    const repository = { owner: "acme", repo: "app", remoteUrl: source };
    let uploads = 0;
    const files = createLinearFileTransfer({
      client: {
        query: async () => ({
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload",
              assetUrl: "https://uploads.linear.app/workspace/result.txt",
              headers: [],
            },
          },
        }),
      },
      auth: { ensureFresh: async () => "host-only-token" },
      fetch: async (_url, request) => {
        expect(request?.method).toBe("PUT");
        uploads++;
        return new Response(null, { status: 200 });
      },
    });
    const purposes: string[] = [];
    const reads: string[] = [];
    const attach = () => {
      const jobs = new JobLoop(db, systemClock);
      const outbox = new OutboxDispatcher(db, systemClock);
      const orchestrator = attachOrchestrator({
        db,
        jobs,
        outbox,
        home,
        pawsRoot: root,
        tracker,
        files,
        secretsDir: join(root, "secrets"),
        linearTaskModes: true,
        repositories: repositoryChoice
          ? [{ ...repository, repo: "other" }, repository]
          : [repository],
        repositoryAccess: async (selected, _signal, access) => {
          expect(selected.owner).toBe(repository.owner);
          expect(access).toBe("read");
          reads.push(access!);
          return true;
        },
        launch(input) {
          purposes.push(input.purpose);
          const classifier = input.purpose === "classify";
          const choosing = input.purpose === "select_repository";
          if (!classifier && !choosing) {
            expect(input.purpose).toBe(mode);
            expect(input.prompt).toContain("./repository");
            expect(input.prompt).toContain(initialHead);
            expect(readFileSync(join(input.worktree, "repository", "app.txt"), "utf8")).toBe(
              "Application source",
            );
            expect(existsSync(join(input.worktree, "repository", ".git"))).toBe(false);
          }
          const script = join(home, `${purposes.length}.script.json`);
          const trace = join(home, `${purposes.length}.trace.json`);
          writeFileSync(
            script,
            JSON.stringify({
              steps: [
                ...(!classifier && !choosing
                  ? [
                      { type: "fs_read", path: "repository/app.txt" },
                      {
                        type: "fs_write",
                        path: "repository/app.txt",
                        content: "Private scratch source",
                      },
                    ]
                  : []),
                ...(!classifier && !choosing && mode === "artifact"
                  ? [
                      {
                        type: "fs_write",
                        path: "result.txt",
                        content: "Repository-based deliverable",
                      },
                      {
                        type: "publish_artifact",
                        path: "result.txt",
                        displayName: "result.txt",
                        mimeType: "text/plain",
                      },
                    ]
                  : []),
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: classifier
                        ? JSON.stringify(
                            scenario === "clarify" && purposes.length === 1
                              ? { mode: "clarify", question: "What should I prepare?" }
                              : { mode, repository: true },
                          )
                        : choosing
                          ? JSON.stringify({ repositoryFullName: "acme/app" })
                          : "Complete repository result.",
                    },
                  },
                },
                { type: "end" },
              ],
            }),
          );
          return {
            command: process.execPath,
            args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
          };
        },
      });
      return { orchestrator, jobs, outbox };
    };
    let f = attach();
    try {
      const event: AcceptedLinearEvent = {
        dedupeKey: "created",
        deliveryId: null,
        source: "webhook",
        action: "created",
        sessionId: "session",
        issueId: "issue",
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: 1,
        payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
      };
      await f.orchestrator.onLinearEvent(event);
      const itemId = db.query<{ id: string }, []>("SELECT id FROM work_item").get()!.id;
      expect(taskRequiresRepository(db, itemId)).toBe(scenario !== "clarify");
      expect(purposes).toEqual(["classify"]);
      if (scenario === "clarify") {
        await f.jobs.tick();
        expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
        await f.orchestrator.onLinearEvent({
          ...event,
          dedupeKey: "clarification",
          action: "prompted",
          activityId: "clarification",
          body: "Explain the repository source",
          payload: JSON.stringify({ agentActivity: { userId: "human" } }),
          updatedAtMs: Date.now() + 1,
          activityCreatedAtMs: Date.now() + 1,
          actorId: "human",
        });
      }
      if (repositoryChoice) {
        await f.jobs.tick();
        expect(findOpenQuestion(db, "session")?.options).toHaveLength(2);
        expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
      }
      db.close();
      db = openDatabase(dbPath);
      migrate(db);
      f = attach();
      if (repositoryChoice) {
        await f.orchestrator.onLinearEvent({
          ...event,
          dedupeKey: "repository-answer",
          action: "prompted",
          activityId: "repository-answer",
          body: scenario === "repository_freeform" ? "Use app, not other." : "2",
          payload: JSON.stringify({ agentActivity: { userId: "human" } }),
          updatedAtMs: Date.now() + 1,
          activityCreatedAtMs: Date.now() + 1,
          actorId: "human",
        });
        expect(getLinearSessionGeneration(db, "session")).toBe(0);
      }
      await f.jobs.tick();
      expect(getWorkItem(db, itemId)?.state).toBe("completed");
      expect(getWorkItemRepository(db, itemId)).toEqual(repository);
      expect(taskRequiresRepository(db, itemId)).toBe(true);
      expect(purposes).toEqual(
        scenario === "clarify"
          ? ["classify", "classify", mode]
          : scenario === "repository_freeform"
            ? ["classify", "select_repository", mode]
            : ["classify", mode],
      );
      expect(reads).toEqual(Array(repositoryChoice ? 5 : 1).fill("read"));
      expect(tracker.statuses).toEqual([]);
      expect(uploads).toBe(mode === "artifact" ? 1 : 0);
      expect(readFileSync(join(source, "app.txt"), "utf8")).toBe("Application source");
      expect((await git(["-C", source, "rev-parse", "HEAD"])).trim()).toBe(initialHead);
      expect((await git(["-C", source, "branch", "--format=%(refname:short)"])).trim()).toBe(
        "main",
      );
      expect(existsSync(join(root, "worktrees"))).toBe(false);
      const trace = JSON.parse(readFileSync(join(home, `${purposes.length}.trace.json`), "utf8"));
      expect(trace.fs[0]).toMatchObject({ op: "read", ok: true, content: "Application source" });
      expect(trace.fs[1].ok).toBe(mode === "artifact");
      expect(tracker.progress.some((update) => update.kind === "response")).toBe(true);
    } finally {
      await f.outbox.idle();
      db.close();
    }
  },
  20_000,
);
