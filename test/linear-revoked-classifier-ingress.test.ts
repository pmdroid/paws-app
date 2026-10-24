import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemClock } from "../src/core";
import {
  createInboxStore,
  createFakeTracker,
  linearTokenPath,
  openLinear,
  writeStoredToken,
} from "../src/linear";
import { getLinearSession, isLinearAppRevoked, JobLoop, OutboxDispatcher } from "../src/db";
import { attachOrchestrator, handleLinearAdministration, LinearTaskAccess } from "../src/loop";
import { startServer } from "../src/server";
import { tempDb, tempHome } from "./helpers";

test.each(["revoked", "team-denied", "team-retry", "initial-denied"] as const)(
  "signed %s fences the owned zero-item ACP classifier",
  async (mode) => {
    const db = tempDb();
    const home = tempHome();
    const root = join(home, "paws");
    mkdirSync(root);
    const trace = join(home, "classifier.json");
    const script = join(home, "classifier.script.json");
    writeFileSync(script, JSON.stringify({ steps: [{ type: "hang" }] }));
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-1",
        title: "Explain this system",
        description: null,
        subIssues: [{ linearIssueId: "child", identifier: "ENG-2", title: "Child" }],
      },
    ]);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    let launches = 0;
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: root,
      home,
      tracker,
      linearTaskModes: true,
      launch: (input) => {
        expect(input.purpose).toBe("classify");
        launches++;
        return {
          command: process.execPath,
          args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        };
      },
    });
    const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
    const secret = "fake-webhook-secret";
    writeStoredToken(linearTokenPath(join(root, "secrets")), {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAtMs: Date.now() + 600_000,
      actor: "app",
      scope: "read,write",
    });
    let gate: LinearTaskAccess;
    let joined = false;
    let lostTeam = mode === "initial-denied";
    let failedRead = false;
    const requests: string[] = [];
    const opened = openLinear({
      db,
      secretsDir: join(root, "secrets"),
      env: { LINEAR_CLIENT_ID: "client", LINEAR_APP_USER_ID: "app" },
      publicUrl: null,
      noTunnel: true,
      isAuthorized: () => !isLinearAppRevoked(db, scope),
      beforeEvent: async (event) => {
        if (
          await handleLinearAdministration(db, event, {
            ...scope,
            notify: () => {
              throw new Error("The classifier has no work item to cancel");
            },
            revalidate: (sessionIds) => gate.revalidateSessions(sessionIds),
            interrupt: async (sessionId) => {
              expect(isLinearAppRevoked(db, scope)).toBe(true);
              await orchestrator.interruptLinearSession(sessionId);
              joined = true;
            },
          })
        )
          return false;
        return gate.accept(event);
      },
      followUp: (event) => orchestrator.onLinearEvent(event),
      fetch: async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        requests.push(payload.query);
        if (payload.query.includes("PawsSessionInstallation"))
          return Response.json({
            data: {
              viewer: { id: "app", app: true, organization: { id: "org" } },
              agentSession: {
                id: "session",
                appUser: { id: "app", app: true, organization: { id: "org" } },
                issue: { id: "issue", team: { id: "team" } },
              },
            },
          });
        if (payload.query.includes("PawsTeamAccess")) {
          if (lostTeam && mode === "team-retry" && !failedRead) {
            failedRead = true;
            throw new Error("Temporary team access read failure");
          }
          return Response.json({ data: { team: lostTeam ? null : { id: "team" } } });
        }
        return Response.json({
          data: { agentActivityCreate: { success: true, agentActivity: { id: "first-ack" } } },
        });
      },
    });
    gate = new LinearTaskAccess(db, {
      access: opened.access,
      lifecycle: opened.issueLifecycle,
      oauthClientId: "client",
      appUserId: "app",
      stopSession: () => {
        expect(getLinearSession(db, "session")?.stoppedAt).not.toBeNull();
      },
      interruptSession: async (sessionId) => {
        await orchestrator.interruptLinearSession(sessionId);
        joined = true;
      },
    });
    const server = startServer({
      port: 0,
      linearWebhookSecret: secret,
      linearWebhook: opened.webhook,
      webhooks: true,
    });
    const post = (event: object, delivery: string) => {
      const body = JSON.stringify({ ...scope, ...event, webhookTimestamp: Date.now() });
      return fetch(new URL("/webhooks/linear", server.url), {
        method: "POST",
        headers: {
          "linear-delivery": delivery,
          "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
        },
        body,
      });
    };
    try {
      if (mode === "initial-denied")
        expect(
          (
            await post(
              {
                type: "PermissionChange",
                action: "teamAccessChanged",
                createdAt: new Date().toISOString(),
                canAccessAllPublicTeams: false,
                addedTeamIds: [],
                removedTeamIds: ["team"],
              },
              "initial-denial",
            )
          ).status,
        ).toBe(200);
      expect(
        (
          await post(
            {
              type: "AgentSessionEvent",
              action: "created",
              agentSession: {
                id: "session",
                creatorId: "human",
                issue: { id: "issue", team: { id: "team" } },
              },
            },
            "created",
          )
        ).status,
      ).toBe(200);
      if (mode === "initial-denied") {
        for (let i = 0; i < 1_000; i++) {
          if (joined) break;
          await Bun.sleep(5);
        }
        expect(joined).toBe(true);
        expect(launches).toBe(0);
        expect(requests.every((query) => !query.includes("mutation"))).toBe(true);
        expect(getLinearSession(db, "session")?.stoppedAt).not.toBeNull();
        expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(0);
        return;
      }
      for (let i = 0; i < 1_000; i++) {
        if (
          existsSync(trace) &&
          JSON.parse(readFileSync(trace, "utf8")).methods.includes("session/prompt")
        )
          break;
        await Bun.sleep(5);
      }
      expect(JSON.parse(readFileSync(trace, "utf8")).methods).toContain("session/prompt");
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(0);
      const before = requests.length;
      lostTeam = mode !== "revoked";
      const administration =
        mode === "revoked"
          ? { type: "OAuthApp", action: "revoked", createdAt: new Date().toISOString() }
          : {
              type: "PermissionChange",
              action: "teamAccessChanged",
              createdAt: new Date().toISOString(),
              canAccessAllPublicTeams: false,
              addedTeamIds: [],
              removedTeamIds: [],
            };
      expect((await post(administration, "administration")).status).toBe(200);
      if (mode === "team-retry") {
        for (let i = 0; i < 1_000; i++) {
          if (failedRead) break;
          await Bun.sleep(5);
        }
        expect(failedRead).toBe(true);
        expect(createInboxStore(db).listUnhandled()).not.toEqual([]);
        expect((await post(administration, "administration")).status).toBe(200);
      }
      for (let i = 0; i < 1_000; i++) {
        if (joined) break;
        await Bun.sleep(5);
      }
      expect(joined).toBe(true);
      expect(getLinearSession(db, "session")?.stoppedAt).not.toBeNull();
      expect(getLinearSession(db, "session")?.generation).toBe(1);
      expect(JSON.parse(readFileSync(trace, "utf8")).methods).toContain("session/cancel");
      if (mode === "revoked") expect(requests).toHaveLength(before);
      else expect(requests.slice(before).every((query) => !query.includes("mutation"))).toBe(true);
      expect(launches).toBe(1);
      expect(tracker.progress).toEqual([]);
      for (let i = 0; i < 100 && createInboxStore(db).listUnhandled().length > 0; i++)
        await Bun.sleep(5);
      expect(createInboxStore(db).listUnhandled()).toEqual([]);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(0);
    } finally {
      await orchestrator.shutdown();
      server.stop(true);
      db.close();
    }
  },
  15_000,
);
