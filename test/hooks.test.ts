import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { listHooks, migrate, openDatabase, saveSkill } from "../src/db";
import { RunnerCommandSchema, RunnerEventSchema } from "../src/runner-protocol";
import { handleHookSettingsRequest, type HookSettingsOptions } from "../src/settings";

let root: string;
let db: Database;
let audits: [string, string][];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-hooks-"));
  db = openDatabase(join(root, "paws.db"));
  migrate(db);
  audits = [];
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function options(role?: string): HookSettingsOptions {
  return {
    db,
    csrfToken: "csrf",
    ...(role ? { role } : {}),
    audit: (action, subject) => audits.push([action, subject]),
    now: () => 1_000,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:8787/api/settings/hooks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf", ...headers },
    body: JSON.stringify(body),
  });
}

async function read(response: Response | null) {
  return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
}

describe("hook settings", () => {
  test("an admin adds and removes a hook, and both changes are audited", async () => {
    const added = await read(
      await handleHookSettingsRequest(
        post({
          action: "add",
          event: "after_edit",
          command: "bun run fmt",
          agents: ["claude", "codex"],
        }),
        options("admin"),
      ),
    );
    expect(added.status).toBe(200);
    const [hook] = listHooks(db);
    expect(hook).toMatchObject({
      event: "after_edit",
      matcher: null,
      command: "bun run fmt",
      timeoutSeconds: 60,
      agents: ["claude", "codex"],
      skill: null,
    });
    expect(audits).toEqual([
      ["settings.hook.add", "Added hook after a file edit: bun run fmt for Claude, Codex"],
    ]);
    const removed = await read(
      await handleHookSettingsRequest(post({ action: "remove", id: hook!.id }), options("admin")),
    );
    expect(removed.status).toBe(200);
    expect(listHooks(db)).toEqual([]);
    expect(audits[1]?.[0]).toBe("settings.hook.remove");
  });

  test("a hook can run when a session starts", async () => {
    const added = await read(
      await handleHookSettingsRequest(
        post({ action: "add", event: "session_start", command: "setup-tools" }),
        options("admin"),
      ),
    );
    expect(added.status).toBe(200);
    expect(added.body.events).toContainEqual({
      id: "session_start",
      label: "When a session starts",
    });
    expect(listHooks(db)[0]).toMatchObject({ event: "session_start", matcher: null });
    expect(audits[0]?.[1]).toBe("Added hook when a session starts: setup-tools for Claude, Codex");
  });

  test("members cannot list or change hooks", async () => {
    const listed = await handleHookSettingsRequest(
      new Request("http://127.0.0.1:8787/api/settings/hooks"),
      options("member"),
    );
    expect(listed!.status).toBe(403);
    const added = await handleHookSettingsRequest(
      post({ action: "add", event: "stop", command: "true" }),
      options("member"),
    );
    expect(added!.status).toBe(403);
    expect(listHooks(db)).toEqual([]);
  });

  test("a change needs the CSRF token", async () => {
    const response = await handleHookSettingsRequest(
      post({ action: "add", event: "stop", command: "true" }, { "x-paws-csrf": "" }),
      options("admin"),
    );
    expect(response!.status).toBe(403);
  });

  test("invalid hooks are refused with a reason", async () => {
    const cases: [unknown, string][] = [
      [{ action: "add", event: "whenever", command: "true" }, "Choose when the hook runs."],
      [{ action: "add", event: "stop", command: " " }, "Enter the hook's command."],
      [
        { action: "add", event: "after_edit", command: "true", matcher: "Bash" },
        "Only a hook that runs before a tool call takes a tool matcher.",
      ],
      [
        { action: "add", event: "session_start", command: "true", matcher: "Bash" },
        "Only a hook that runs before a tool call takes a tool matcher.",
      ],
      [{ action: "add", event: "stop", command: "true", timeoutSeconds: 0 }, "Set a timeout"],
      [{ action: "add", event: "stop", command: "true", agents: ["grok"] }, "Choose the agents"],
      [{ action: "add", event: "stop", command: "a\nb" }, "Put the command on one line."],
      [{ action: "add", event: "stop", command: "x", skill: "missing" }, "No registered skill"],
    ];
    for (const [body, error] of cases) {
      const response = await read(await handleHookSettingsRequest(post(body), options("admin")));
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain(error);
    }
    expect(listHooks(db)).toEqual([]);
  });

  test("a hook can run a script from a registered skill installed for its agents", async () => {
    saveSkill(db, {
      name: "guard",
      source: { kind: "npm", package: "guard" },
      version: "1.0.0",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      agents: ["claude"],
      updatedAt: 1,
    });
    const both = await read(
      await handleHookSettingsRequest(
        post({
          action: "add",
          event: "before_shell",
          command: '"$PAWS_SKILL_DIR/guard.sh"',
          skill: "guard",
        }),
        options("admin"),
      ),
    );
    expect(both.status).toBe(400);
    expect(String(both.body.error)).toContain("guard is not installed for Codex");
    const claude = await read(
      await handleHookSettingsRequest(
        post({
          action: "add",
          event: "before_shell",
          command: '"$PAWS_SKILL_DIR/guard.sh"',
          skill: "guard",
          agents: ["claude"],
        }),
        options("admin"),
      ),
    );
    expect(claude.status).toBe(200);
    expect(claude.body.skills).toEqual([{ name: "guard", agents: ["claude"] }]);
    expect(listHooks(db)[0]?.skill).toBe("guard");
  });
});

describe("runner protocol", () => {
  const run = {
    id: "cmd",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1,
    expiresAt: 2,
    type: "run",
    runId: "run",
    itemId: "item",
    generation: 0,
    repository: {
      owner: "acme",
      repo: "app",
      remoteUrl: "https://github.com/acme/app.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "claude", model: null },
    prompt: "Do it.",
  };
  const hook = {
    id: "hook_1",
    event: "before_tool",
    matcher: "mcp__.*",
    command: "audit",
    timeoutSeconds: 30,
    agents: ["claude"],
    skill: null,
  };

  test("a run command carries workspace hooks", () => {
    expect(RunnerCommandSchema.safeParse({ ...run, hooks: [hook] }).success).toBe(true);
    expect(
      RunnerCommandSchema.safeParse({ ...run, hooks: [{ ...hook, event: "stop" }] }).success,
    ).toBe(false);
    expect(
      RunnerCommandSchema.safeParse({
        ...run,
        hooks: [{ ...hook, event: "session_start", matcher: null }],
      }).success,
    ).toBe(true);
    expect(
      RunnerCommandSchema.safeParse({ ...run, hooks: [{ ...hook, command: "a\nb" }] }).success,
    ).toBe(false);
  });

  test("a failed hook is a runner event", () => {
    expect(
      RunnerEventSchema.safeParse({
        type: "hook_failed",
        hookId: "hook_1",
        hookEvent: "after_edit",
        command: "bun run fmt",
        reason: "exited with 1",
      }).success,
    ).toBe(true);
  });
});
