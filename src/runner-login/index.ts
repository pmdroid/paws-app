import {
  AgentAccountError,
  auditWorkspaceAccessSteps,
  bindingRunningCountSteps,
  cancelPendingRunnerLoginsSteps,
  closeRunnerLoginSteps,
  emitJobReady,
  getAgentAccountSteps,
  getAgentBindingSteps,
  getRunnerSteps,
  insertRunnerLoginSteps,
  latestAgentRunnerLoginIdSteps,
  latestBindingRunnerLoginIdSteps,
  legacyAgentAccountId,
  legacyAgentBindingId,
  pendingRunnerLoginCountSteps,
  pendingRunnerLoginIdSteps,
  recordAccountObservationSteps,
  runnerAccountUnsupportedSteps,
  runnerAgentOpenWorkCountSteps,
  runnerAgentPolicyStateSteps,
  runnerLoginRowSteps,
  runnerNamedBindingsSteps,
  setRunnerAgentSignedInSteps,
  storedAgentBindingIdSteps,
  updateRunnerLoginSteps,
  wakeRunnerSlotWaitsSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Q,
  type RunnerLoginRow,
  type Steps,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import type { WorkspacePrincipal } from "../workspace";
import type { RunnerWork } from "../runner-work";
import {
  RunnerLoginInputSchema,
  RunnerLoginUpdateSchema,
  type RunnerAccount,
  type RunnerLoginInput,
  type RunnerLoginUpdate,
} from "../runner-protocol";

type Agent = RunnerLoginRow["agent"];
type Row = RunnerLoginRow;
const bindingParameter = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** How long a sign-in may wait for the person. It starts this long before it expires. */
const SIGN_IN_MS = 600_000;
const pending = (row: Row) => row.state === "starting" || row.state === "waiting";

class SignInRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createRunnerLogin(options: {
  store: Db;
  work: RunnerWork;
  now?: () => number;
  /** Called after a sign-in completes, outside its transaction. */
  onSignedIn?: (input: { runnerId: string; agent: Agent }) => void;
}) {
  const { store, work } = options;
  const now = options.now ?? Date.now;
  const inputs = new Map<string, { id: string; value: RunnerLoginInput }>();
  function* accessSteps(q: Q, workspaceId: string, userId: string, runnerId: string) {
    const member = yield* workspaceMemberSteps(q, workspaceId, userId);
    const runner = yield* getRunnerSteps(q, runnerId);
    if (
      !workspaceMemberUsable(member) ||
      !runner ||
      runner.workspaceId !== workspaceId ||
      runner.ownerUserId !== userId ||
      (runner.status !== "active" && runner.status !== "paused") ||
      !workspaceMemberUsable(yield* workspaceMemberSteps(q, workspaceId, runner.ownerUserId))
    )
      throw new Error("Agent account access denied");
    return runner;
  }
  function* readSteps(q: Q, id: string): Steps<Row> {
    const row = yield* runnerLoginRowSteps(q, id);
    if (!row) throw new Error("Login session is unavailable");
    if (pending(row) && row.expiresAt <= now()) {
      yield* closeRunnerLoginSteps(q, id, "expired");
      inputs.delete(id);
      return {
        ...row,
        state: "expired" as const,
        terminal: "",
        authorization: null,
        inputId: null,
      };
    }
    return row;
  }
  function snapshot(row: Row) {
    return {
      id: row.id,
      agent: row.agent,
      bindingId: row.bindingId,
      state: row.state,
      startedAt: row.expiresAt - SIGN_IN_MS,
      expiresAt: row.expiresAt,
      terminal: row.terminal,
      authorization: row.authorization
        ? (JSON.parse(row.authorization) as { url: string; message: string })
        : null,
    };
  }
  function* ownSteps(
    q: Q,
    principal: WorkspacePrincipal,
    runnerId: string,
    agent: Agent,
    id: string,
  ) {
    yield* accessSteps(q, principal.workspaceId, principal.userId, runnerId);
    const row = yield* readSteps(q, id);
    if (
      row.runnerId !== runnerId ||
      row.workspaceId !== principal.workspaceId ||
      row.userId !== principal.userId ||
      row.agent !== agent
    )
      throw new Error("Login session access denied");
    return row;
  }
  function* namedAccountSteps(
    q: Q,
    principal: WorkspacePrincipal,
    runnerId: string,
    agent: Agent,
    bindingId: string,
  ): Steps<RunnerAccount | null> {
    const binding = yield* getAgentBindingSteps(q, principal.workspaceId, bindingId);
    if (binding.legacy && binding.runnerId === runnerId && binding.agent === agent) return null;
    const account = yield* getAgentAccountSteps(q, principal.workspaceId, binding.accountId);
    if (
      binding.legacy ||
      binding.runnerId !== runnerId ||
      binding.agent !== agent ||
      binding.removedAt !== null ||
      account.removedAt !== null
    )
      throw new SignInRefused("This account binding is not available on this runner.", 409);
    return { accountId: account.id, bindingId: binding.id };
  }
  const api = {
    async stop() {
      inputs.clear();
      await store.run((q) => cancelPendingRunnerLoginsSteps(q));
    },
    list(principal: WorkspacePrincipal, runnerId: string) {
      return store.run(function* (q) {
        yield* accessSteps(q, principal.workspaceId, principal.userId, runnerId);
        const agents: Agent[] = [];
        for (const agent of ["claude", "codex", "grok", "opencode"] as const)
          if (yield* work.supportsAgentSteps(q, runnerId, agent)) agents.push(agent);
        const accounts = [];
        for (const agent of agents) {
          const account = yield* runnerAgentPolicyStateSteps(q, runnerId, agent);
          const session = yield* latestAgentRunnerLoginIdSteps(q, {
            runnerId,
            userId: principal.userId,
            agent,
          });
          // Sign-in replaces the credentials these tasks read from their next request on.
          const running = yield* runnerAgentOpenWorkCountSteps(q, runnerId, agent, now());
          const binding = yield* storedAgentBindingIdSteps(
            q,
            legacyAgentBindingId(runnerId, agent),
          );
          accounts.push({
            agent,
            accountId: binding ? legacyAgentAccountId(principal.workspaceId, agent) : null,
            bindingId: binding,
            connected: account?.ready === 1 && account.authExpired === 0,
            running,
            session: session ? snapshot(yield* readSteps(q, session)) : null,
          });
        }
        const bindings = [];
        for (const binding of yield* runnerNamedBindingsSteps(q, runnerId, principal.workspaceId)) {
          if (!agents.includes(binding.agent)) continue;
          const session = yield* latestBindingRunnerLoginIdSteps(q, {
            runnerId,
            userId: principal.userId,
            bindingId: binding.bindingId,
          });
          bindings.push({
            ...binding,
            enabled: binding.enabled === 1,
            held:
              (yield* runnerAccountUnsupportedSteps(
                q,
                runnerId,
                binding.bindingId,
                binding.agent,
              )) === null,
            running: yield* bindingRunningCountSteps(q, binding.bindingId, now()),
            session: session ? snapshot(yield* readSteps(q, session)) : null,
          });
        }
        return { accounts, bindings };
      });
    },
    start(principal: WorkspacePrincipal, runnerId: string, agent: Agent, bindingId?: string) {
      return store.transaction(function* (q) {
        yield* accessSteps(q, principal.workspaceId, principal.userId, runnerId);
        const at = now();
        for (const sessionId of inputs.keys()) yield* readSteps(q, sessionId);
        const account = bindingId
          ? yield* namedAccountSteps(q, principal, runnerId, agent, bindingId)
          : null;
        const existing = yield* pendingRunnerLoginIdSteps(q, {
          runnerId,
          userId: principal.userId,
          agent,
          bindingId: account?.bindingId ?? null,
          at,
        });
        if (existing) return snapshot(yield* readSteps(q, existing));
        if (account && (yield* bindingRunningCountSteps(q, account.bindingId, at)) > 0)
          throw new SignInRefused(
            "Work is still running with this account. Let it finish or stop it, then sign in again.",
            409,
          );
        if ((yield* pendingRunnerLoginCountSteps(q, runnerId, at)) >= 4)
          throw new SignInRefused(
            "This runner already has four sign-ins waiting. Finish one first.",
            429,
          );
        const id = randomUUID();
        const expiresAt = at + SIGN_IN_MS;
        yield* work.enqueueSteps(q, {
          id,
          type: "login",
          runnerId,
          workspaceId: principal.workspaceId,
          agent,
          issuedAt: at,
          expiresAt,
          ...(account ? { account } : {}),
        });
        yield* insertRunnerLoginSteps(q, {
          id,
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          agent,
          expiresAt,
          updatedAt: at,
          bindingId: account?.bindingId ?? null,
        });
        yield* auditWorkspaceAccessSteps(q, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "runner.agent_login",
          subject: `${runnerId}/${agent}${account ? `/${account.bindingId}` : ""}`,
          now: at,
        });
        return snapshot(yield* readSteps(q, id));
      });
    },
    async exchange(runnerId: string, id: string, input: RunnerLoginUpdate) {
      const update = RunnerLoginUpdateSchema.parse(input);
      let signedIn: { runnerId: string; agent: Agent } | undefined;
      let woke = false;
      const reply = await store.transaction(function* (q) {
        const row = yield* readSteps(q, id);
        if (row.runnerId !== runnerId) throw new Error("Login runner changed");
        try {
          yield* accessSteps(q, row.workspaceId, row.userId, runnerId);
        } catch (caughtError1) {
          journalCaught(
            caughtError1,
            "runner-login.exchange.access",
            null,
            "optional file may be absent",
          );
          inputs.delete(id);
          yield* cancelPendingRunnerLoginsSteps(q, id);
          return { cancelled: true, input: null };
        }
        if (!pending(row)) return { cancelled: row.state !== "connected", input: null };
        if (row.agent === "claude" && update.authorization)
          throw new Error("Claude login requires its terminal");
        if (row.agent === "opencode" && update.authorization)
          throw new Error("OpenCode login requires its terminal");
        if (row.agent !== "claude" && row.agent !== "opencode" && update.authorization) {
          const url = new URL(update.authorization.url);
          const allowedHost =
            row.agent === "grok"
              ? url.hostname === "accounts.x.ai" || url.hostname === "auth.x.ai"
              : url.hostname === "auth.openai.com";
          if (url.protocol !== "https:" || !allowedHost || url.username || url.password || url.port)
            throw new Error("Unexpected provider authorization URL");
        }
        const answer = inputs.get(id);
        if (answer && row.inputId !== update.inputId) inputs.delete(id);
        const finished = update.state === "connected" || update.state === "failed";
        if (finished) inputs.delete(id);
        const terminal = finished ? "" : update.terminal;
        yield* updateRunnerLoginSteps(q, id, {
          state: update.state,
          terminal,
          authorization:
            !finished && update.authorization ? JSON.stringify(update.authorization) : null,
          inputId: finished ? null : update.inputId,
          updatedAt: now(),
        });
        if (update.state === "connected" && row.bindingId !== null) inputs.delete(id);
        if (update.state === "connected" && row.bindingId === null) {
          yield* setRunnerAgentSignedInSteps(q, runnerId, row.agent, true);
          woke = yield* wakeRunnerSlotWaitsSteps(q, runnerId, now());
          inputs.delete(id);
          signedIn = { runnerId, agent: row.agent };
        }
        if (update.state === "connected") {
          const at = now();
          yield* q.transaction((tx) =>
            recordAccountObservationSteps(tx, {
              bindingId: row.bindingId ?? legacyAgentBindingId(runnerId, row.agent),
              source: "sign_in",
              sourceId: id,
              observedAt: at,
              now: at,
              state: "ok",
              clears: ["auth"],
            }),
          );
        }
        return {
          cancelled: false,
          input: !finished && answer && answer.id === update.inputId ? answer : null,
        };
      });
      if (woke) emitJobReady(store);
      if (signedIn) {
        try {
          options.onSignedIn?.(signedIn);
        } catch (caughtError2) {
          journalCaught(caughtError2, "runner-login.exchange.onSignedIn", null);
          // The sign-in is already committed; the background check retries later.
        }
      }
      return reply;
    },
    async browser(request: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const match =
        /^\/api\/runners\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/accounts(?:\/(claude|codex|grok|opencode)\/login(?:\/([a-f0-9-]{36})(\/input)?)?)?$/.exec(
          new URL(request.url).pathname,
        );
      if (!match) return null;
      try {
        const runnerId = match[1]!;
        const agent = match[2] as Agent | undefined;
        const id = match[3];
        if (!agent && request.method === "GET") return json(await api.list(principal, runnerId));
        if (agent && !id && request.method === "POST") {
          const binding = new URL(request.url).searchParams.get("binding");
          if (binding !== null && !bindingParameter.test(binding))
            return json({ error: "Unsupported agent account request." }, 400);
          return json(await api.start(principal, runnerId, agent, binding ?? undefined));
        }
        if (!agent || !id) return json({ error: "Unsupported agent account request." }, 405);
        const row = await store.run((q) => ownSteps(q, principal, runnerId, agent, id));
        if (!match[4] && request.method === "GET") return json(snapshot(row));
        if (!match[4] && request.method === "DELETE") {
          if (pending(row)) await store.run((q) => closeRunnerLoginSteps(q, id, "cancelled"));
          inputs.delete(id);
          return json(snapshot(await store.run((q) => readSteps(q, id))));
        }
        if (match[4] && request.method === "POST") {
          const value = RunnerLoginInputSchema.parse(await body(request));
          const current = await store.run((q) => ownSteps(q, principal, runnerId, agent, id));
          if (
            !pending(current) ||
            !current.inputId ||
            current.inputId !== row.inputId ||
            (agent === "claude" || agent === "opencode") !== "text" in value
          )
            throw new Error("Login input is unavailable");
          if (inputs.has(id)) throw new Error("Previous login input is still pending");
          inputs.set(id, { id: current.inputId, value });
          return json(snapshot(current));
        }
        return json({ error: "Unsupported agent account request." }, 405);
      } catch (error) {
        journalCaught(error, "runner-login.browser.json", null);
        if (error instanceof SignInRefused) return json({ error: error.message }, error.status);
        if (error instanceof AgentAccountError && error.code === "runner_unsupported")
          return json({ error: error.message }, 409);
        return json(
          { error: "Agent sign-in is unavailable. Refresh your sign-in and try again." },
          403,
        );
      }
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const match = /^\/v1\/login\/([a-f0-9-]{36})$/.exec(new URL(request.url).pathname);
      if (!match) return null;
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      try {
        return json(
          await api.exchange(
            runnerId,
            match[1]!,
            RunnerLoginUpdateSchema.parse(await body(request)),
          ),
        );
      } catch (caughtError3) {
        journalCaught(caughtError3, "runner-login.fetch.json", null);
        return json({ error: "Login session was rejected." }, 403);
      }
    },
  };
  return api;
}

async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  const cancel = () =>
    void reader.cancel().catch((caughtError4) => {
      journalCaught(caughtError4, "runner-login.body.cancel", null);
      return undefined;
    });
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 131072) throw new Error("Login request exceeds its limit");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch((caughtError5) => {
      journalCaught(caughtError5, "runner-login.body.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
export type RunnerLogin = ReturnType<typeof createRunnerLogin>;
