import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  bindAgentAccount,
  bindingAccountHealth,
  createAgentAccount,
  insertQueuedItem,
  putWorkspaceUser,
  recordRunnerAccountCapability,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerLogin } from "../src/runner-login";
import { workspaceId, type WorkspacePrincipal } from "../src/workspace";
import type { RunnerCommand } from "../src/runner-protocol";
import { seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";

type Agent = "claude" | "codex" | "grok" | "opencode";

const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function fixture() {
  const store = await tempStore();
  stores.push(store);
  const { db } = store;
  let at = Date.now();
  const workspace = workspaceId();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: workspace, linearOrganizationId: "login-org", name: "Login", createdAt: at }),
  );
  // The runner's owner is an admin too, so the other admin is refused only for not owning it.
  const members: WorkspacePrincipal[] = [];
  for (const [index, [name, role]] of (
    [
      ["owner", "admin"],
      ["admin", "admin"],
      ["member", "member"],
    ] as const
  ).entries()) {
    const userId = await putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `login-user-${index}`,
      name,
      email: `${name}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: workspace,
      userId,
      role,
      active: true,
      teamIds: [],
      now: at,
    });
    members.push({
      workspaceId: workspace,
      userId,
      role: role as WorkspacePrincipal["role"],
      teamIds: [],
      authenticatedAt: at,
    });
  }
  const [owner, admin, member] = [members[0]!, members[1]!, members[2]!];
  const runnerId = workspaceId();
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: runnerId,
        workspaceId: workspace,
        ownerUserId: owner.userId,
        name: "Owner runner",
        status: "active",
        createdAt: at,
      }),
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId, sharing: 1 }),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId, runnerVersion: "0.1.83", reportedAt: at }),
  );
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    store: db,
    keyId: "login",
    privateKey: signing.privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => at,
  });
  const service = createRunnerLogin({ store: db, work, now: () => at });
  const bindings = new Map<string, string>();
  for (const agent of ["claude", "codex", "grok", "opencode"] as const) {
    const account = await createAgentAccount(db, {
      workspaceId: workspace,
      ownerUserId: owner.userId,
      agent,
      label: agent,
      now: at,
    });
    const binding = await bindAgentAccount(db, {
      workspaceId: workspace,
      userId: owner.userId,
      accountId: account.id,
      runnerId,
      now: at,
    });
    bindings.set(agent, binding.id);
  }
  await recordRunnerAccountCapability(
    db,
    runnerId,
    {
      protocol: 1,
      bindings: [...bindings].map(([agent, bindingId]) => ({ bindingId, agent: agent as Agent })),
    },
    at,
  );
  const login = {
    ...service,
    start: (principal: WorkspacePrincipal, target: string, agent: Agent) =>
      service.start(principal, target, agent, bindings.get(agent)!),
    browser(request: Request, principal: WorkspacePrincipal) {
      const url = new URL(request.url);
      const agent = /\/accounts\/(\w+)\/login$/.exec(url.pathname)?.[1];
      if (!agent) return service.browser(request, principal);
      url.searchParams.set("binding", bindings.get(agent)!);
      return service.browser(new Request(url.toString(), request), principal);
    },
  };
  const waiting = {
    state: "waiting" as const,
    terminal: "",
    authorization: { url: "https://auth.openai.com/codex/device", message: "Enter the code 1234" },
    inputId: randomUUID(),
  };
  const connected = {
    state: "connected" as const,
    terminal: "",
    authorization: null,
    inputId: null,
  };
  const url = (id: string, suffix = "") =>
    `https://paws.example.invalid/api/runners/${runnerId}/accounts/codex/login/${id}${suffix}`;
  const session = async (agent: Agent) =>
    (await service.list(owner, runnerId)).bindings.find((entry) => entry.agent === agent)?.session;
  const auth = async (agent: Agent) =>
    (await bindingAccountHealth(db, bindings.get(agent)!)).find((row) => row.kind === "auth")
      ?.state ?? null;
  return {
    db,
    owner,
    admin,
    member,
    runnerId,
    work,
    login,
    waiting,
    connected,
    url,
    session,
    auth,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("the owner's account sign-in carries no member and marks its binding signed in", async () => {
  const f = await fixture();
  const session = await f.login.start(f.owner, f.runnerId, "codex");
  expect((await f.login.start(f.owner, f.runnerId, "codex")).id).toBe(session.id);
  const [envelope] = await f.work.commands(f.runnerId);
  const command = JSON.parse(
    Buffer.from(envelope!.payload, "base64url").toString(),
  ) as RunnerCommand;
  expect(command.type).toBe("login");
  expect(command.memberId).toBeUndefined();
  expect(command.type === "login" && command.account?.bindingId).toBe(session.bindingId!);
  await f.login.exchange(f.runnerId, session.id, f.waiting);
  expect(await f.auth("codex")).toBeNull();
  await f.login.exchange(f.runnerId, session.id, f.connected);
  expect(await f.auth("codex")).toBe("ok");
  expect((await f.session("codex"))?.state).toBe("connected");
});

test("only the runner owner can start, read, answer or list a sign-in", async () => {
  const f = await fixture();
  for (const principal of [f.admin, f.member]) {
    await expect(f.login.start(principal, f.runnerId, "claude")).rejects.toThrow();
    await expect(f.login.list(principal, f.runnerId)).rejects.toThrow();
  }
  expect(await logins(f.db)).toEqual([]);
  const session = await f.login.start(f.owner, f.runnerId, "codex");
  await f.login.exchange(f.runnerId, session.id, f.waiting);
  for (const method of ["GET", "DELETE"])
    expect(
      (await f.login.browser(new Request(f.url(session.id), { method }), f.admin))!.status,
    ).toBe(403);
  const answer = (principal: WorkspacePrincipal) =>
    f.login.browser(
      new Request(f.url(session.id, "/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true }),
      }),
      principal,
    );
  expect((await answer(f.member))!.status).toBe(403);
  expect((await answer(f.owner))!.status).toBe(200);
  expect((await f.login.exchange(f.runnerId, session.id, f.waiting)).input).toEqual({
    id: f.waiting.inputId,
    value: { accept: true },
  });
  expect(
    (await f.login.exchange(f.runnerId, session.id, { ...f.waiting, inputId: null })).input,
  ).toBeNull();
});

test("revocation, expiry and cancellation fence provider completion", async () => {
  for (const condition of ["revoked", "expired", "cancelled", "shutdown", "transferred"] as const) {
    const f = await fixture();
    const session = await f.login.start(f.owner, f.runnerId, "codex");
    if (condition === "revoked")
      await seed(f.db, (q) =>
        q.orm
          .update(q.t.workspaceMember)
          .set({ active: 0 })
          .where(eq(q.t.workspaceMember.userId, f.owner.userId)),
      );
    if (condition === "expired") f.advance(600001);
    if (condition === "shutdown") await f.login.stop();
    if (condition === "transferred")
      await seed(f.db, (q) =>
        q.orm
          .update(q.t.runner)
          .set({ ownerUserId: f.admin.userId })
          .where(eq(q.t.runner.id, f.runnerId)),
      );
    if (condition === "cancelled")
      await f.login.browser(new Request(f.url(session.id), { method: "DELETE" }), f.owner);
    expect((await f.login.exchange(f.runnerId, session.id, f.connected)).cancelled).toBe(true);
    expect(await f.auth("codex")).toBeNull();
  }
});

test("login rejects foreign runners and provider URL substitution", async () => {
  const f = await fixture();
  const session = await f.login.start({ ...f.owner, authenticatedAt: 0 }, f.runnerId, "codex");
  await expect(f.login.exchange(workspaceId(), session.id, f.waiting)).rejects.toThrow();
  await expect(
    f.login.exchange(f.runnerId, session.id, {
      ...f.waiting,
      authorization: { url: "https://evil.example.invalid/authorize", message: "Open" },
    }),
  ).rejects.toThrow();
});

test("delayed login input is rejected after cancellation, revocation, expiry or prompt changes", async () => {
  for (const change of ["cancelled", "revoked", "expired", "prompt"] as const) {
    const f = await fixture();
    const session = await f.login.start(f.owner, f.runnerId, "codex");
    await f.login.exchange(f.runnerId, session.id, f.waiting);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const reading = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          reading.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = f.login.browser(
      new Request(f.url(session.id, "/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      f.owner,
    );
    await reading.promise;
    if (change === "cancelled")
      await f.login.browser(new Request(f.url(session.id), { method: "DELETE" }), f.owner);
    if (change === "revoked")
      await seed(f.db, (q) =>
        q.orm
          .update(q.t.workspaceMember)
          .set({ active: 0 })
          .where(eq(q.t.workspaceMember.userId, f.owner.userId)),
      );
    if (change === "expired") f.advance(600001);
    const current = change === "prompt" ? { ...f.waiting, inputId: randomUUID() } : f.waiting;
    if (change === "prompt") await f.login.exchange(f.runnerId, session.id, current);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ accept: true })));
    controller.close();
    expect((await pending)!.status).toBe(403);
    expect((await f.login.exchange(f.runnerId, session.id, current)).input).toBeNull();
  }
});

test("Grok device login rejects foreign authorization hosts and connects the account", async () => {
  const f = await fixture();
  const endpoint = `https://paws.example.invalid/api/runners/${f.runnerId}/accounts/grok/login`;
  const response = await f.login.browser(new Request(endpoint, { method: "POST" }), f.owner);
  expect(response?.status).toBe(200);
  const session = (await response!.json()) as { id: string };
  const waiting = {
    ...f.waiting,
    inputId: null,
    authorization: {
      url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      message: "Enter ABCD-1234",
    },
  };
  await expect(f.login.exchange(f.runnerId, session.id, f.waiting)).rejects.toThrow(
    "authorization URL",
  );
  for (const url of [
    "https://auth.x.ai.evil.invalid/device",
    "http://auth.x.ai/device",
    "https://user@auth.x.ai/device",
    "https://auth.x.ai:444/device",
    "https://accounts.x.ai.evil.invalid/oauth2/device",
    "http://accounts.x.ai/oauth2/device",
    "https://user@accounts.x.ai/oauth2/device",
    "https://accounts.x.ai:444/oauth2/device",
  ])
    await expect(
      f.login.exchange(f.runnerId, session.id, {
        ...waiting,
        authorization: { url, message: "Enter ABCD-1234" },
      }),
    ).rejects.toThrow();
  await f.login.exchange(f.runnerId, session.id, {
    ...waiting,
    authorization: { url: "https://auth.x.ai/device", message: "Enter ABCD-1234" },
  });
  await f.login.exchange(f.runnerId, session.id, waiting);
  expect((await f.session("grok"))?.authorization).toEqual(waiting.authorization);
  await f.login.exchange(f.runnerId, session.id, f.connected);
  expect(await f.auth("grok")).toBe("ok");
});

test("starting another sign-in keeps an agent that is already connected", async () => {
  const f = await fixture();
  const session = await f.login.start(f.owner, f.runnerId, "grok");
  await f.login.exchange(f.runnerId, session.id, f.connected);
  f.advance(1_000);
  const again = await f.login.start(f.owner, f.runnerId, "grok");
  expect(again.id).not.toBe(session.id);
  expect(again.state).toBe("starting");
  expect(await f.auth("grok")).toBe("ok");
});

function logins(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({ agent: q.t.runnerLogin.agent, state: q.t.runnerLogin.state })
        .from(q.t.runnerLogin),
    ),
  );
}

async function busy(f: Awaited<ReturnType<typeof fixture>>, agent: string) {
  const runId = `busy-run-${agent}`;
  await insertQueuedItem(f.db, { id: `busy-item-${agent}`, now: 0 });
  await seed(
    f.db,
    (q) =>
      q.orm.insert(q.t.run).values({
        id: runId,
        itemId: `busy-item-${agent}`,
        kind: "implement",
        agent,
        status: "active",
        createdAt: 0,
        updatedAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId,
        runnerId: f.runnerId,
        workspaceId: f.owner.workspaceId,
        generation: 1,
        runnerFence: 0,
        commandId: `busy-command-${agent}`,
        leaseUntil: Date.now() + 60_000,
      }),
  );
  return () =>
    f.db.run((q) =>
      q.one(q.orm.select().from(q.t.runnerWork).where(eq(q.t.runnerWork.runId, runId))),
    );
}

for (const agent of ["claude", "grok"] as const) {
  test(`a sign-in to ${agent} starts while the runner runs a Claude task`, async () => {
    const f = await fixture();
    await busy(f, "claude");
    const response = (await f.login.browser(
      new Request(
        `https://paws.example.invalid/api/runners/${f.runnerId}/accounts/${agent}/login`,
        {
          method: "POST",
        },
      ),
      f.owner,
    ))!;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { state: string }).state).toBe("starting");
    expect(await logins(f.db)).toEqual([{ agent, state: "starting" }]);
  });
}

test("a runner with four sign-ins waiting refuses another, even while it works", async () => {
  const f = await fixture();
  await busy(f, "codex");
  for (const agent of ["claude", "codex", "grok"] as const)
    await f.login.start(f.owner, f.runnerId, agent);
  // Sign-ins left waiting by the runner's earlier owners still count.
  for (const earlier of [f.admin, f.member]) {
    await seed(f.db, (q) =>
      q.orm
        .update(q.t.runnerLogin)
        .set({ userId: earlier.userId })
        .where(and(eq(q.t.runnerLogin.userId, f.owner.userId), eq(q.t.runnerLogin.agent, "grok"))),
    );
    if (earlier === f.admin)
      expect((await f.login.start(f.owner, f.runnerId, "grok")).state).toBe("starting");
  }
  const response = (await f.login.browser(
    new Request(`https://paws.example.invalid/api/runners/${f.runnerId}/accounts/grok/login`, {
      method: "POST",
    }),
    f.owner,
  ))!;
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    error: "This runner already has four sign-ins waiting. Finish one first.",
  });
});

test("the owner can sign in agents on a paused runner, not on a draining or revoked one", async () => {
  const f = await fixture();
  const status = (value: string) =>
    seed(f.db, (q) =>
      q.orm.update(q.t.runner).set({ status: value }).where(eq(q.t.runner.id, f.runnerId)),
    );
  await status("paused");
  const session = await f.login.start(f.owner, f.runnerId, "claude");
  expect(session.state).toBe("starting");
  expect((await f.login.list(f.owner, f.runnerId)).bindings.length).toBeGreaterThan(0);
  for (const value of ["draining", "revoked"]) {
    await status(value);
    await expect(f.login.start(f.owner, f.runnerId, "codex")).rejects.toThrow();
  }
});

test("Claude setup-token sign-in rejects an older runner with an upgrade reason", async () => {
  const f = await fixture();
  await seed(f.db, (q) =>
    q.orm
      .update(q.t.runnerHostStatus)
      .set({ runnerVersion: "0.1.82" })
      .where(eq(q.t.runnerHostStatus.runnerId, f.runnerId)),
  );
  await expect(f.login.start(f.owner, f.runnerId, "claude")).rejects.toThrow(
    "Claude OAuth credentials need runner 0.1.83 or later",
  );
  expect(await logins(f.db)).toEqual([]);
});
