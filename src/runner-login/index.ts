import {
  workspaceMemberUsable,
  AgentAccountError,
  auditWorkspaceAccess,
  bindingRunningCount,
  cancelPendingRunnerLogins,
  closeRunnerLogin,
  getAgentAccount,
  getAgentBinding,
  getRunner,
  immediate,
  insertRunnerLogin,
  latestAgentRunnerLoginId,
  latestBindingRunnerLoginId,
  legacyAgentAccountId,
  legacyAgentBindingId,
  pendingRunnerLoginCount,
  pendingRunnerLoginId,
  recordAccountObservation,
  runnerAccountUnsupported,
  runnerAgentOpenWorkCount,
  runnerAgentPolicyState,
  runnerLoginRow,
  runnerNamedBindings,
  setRunnerAgentSignedIn,
  storedAgentBindingId,
  updateRunnerLogin,
  wakeRunnerSlotWaits,
  workspaceMember,
  type RunnerLoginRow,
} from "../db";
import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
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
  db: Database;
  work: RunnerWork;
  now?: () => number;
  /** Called after a sign-in completes, outside its transaction. */
  onSignedIn?: (input: { runnerId: string; agent: Agent }) => void;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  const inputs = new Map<string, { id: string; value: RunnerLoginInput }>();
  function access(workspaceId: string, userId: string, runnerId: string) {
    const member = workspaceMember(db, workspaceId, userId);
    const runner = getRunner(db, runnerId);
    if (
      !workspaceMemberUsable(member) ||
      !runner ||
      runner.workspaceId !== workspaceId ||
      runner.ownerUserId !== userId ||
      (runner.status !== "active" && runner.status !== "paused") ||
      !workspaceMemberUsable(workspaceMember(db, workspaceId, runner.ownerUserId))
    )
      throw new Error("Agent account access denied");
    return runner;
  }
  function read(id: string) {
    const row = runnerLoginRow(db, id);
    if (!row) throw new Error("Login session is unavailable");
    if (pending(row) && row.expiresAt <= now()) {
      closeRunnerLogin(db, id, "expired");
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
  function own(principal: WorkspacePrincipal, runnerId: string, agent: Agent, id: string) {
    access(principal.workspaceId, principal.userId, runnerId);
    const row = read(id);
    if (
      row.runnerId !== runnerId ||
      row.workspaceId !== principal.workspaceId ||
      row.userId !== principal.userId ||
      row.agent !== agent
    )
      throw new Error("Login session access denied");
    return row;
  }
  function namedAccount(
    principal: WorkspacePrincipal,
    runnerId: string,
    agent: Agent,
    bindingId: string,
  ): RunnerAccount | null {
    const binding = getAgentBinding(db, principal.workspaceId, bindingId);
    if (binding.legacy && binding.runnerId === runnerId && binding.agent === agent) return null;
    const account = getAgentAccount(db, principal.workspaceId, binding.accountId);
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
    stop() {
      inputs.clear();
      cancelPendingRunnerLogins(db);
    },
    list(principal: WorkspacePrincipal, runnerId: string) {
      access(principal.workspaceId, principal.userId, runnerId);
      const agents = (["claude", "codex", "grok", "opencode"] as const).filter((agent) =>
        work.supportsAgent(runnerId, agent),
      );
      return {
        accounts: agents.map((agent) => {
          const account = runnerAgentPolicyState(db, runnerId, agent);
          const session = latestAgentRunnerLoginId(db, {
            runnerId,
            userId: principal.userId,
            agent,
          });
          // Sign-in replaces the credentials these tasks read from their next request on.
          const running = runnerAgentOpenWorkCount(db, runnerId, agent, now());
          const binding = storedAgentBindingId(db, legacyAgentBindingId(runnerId, agent));
          return {
            agent,
            accountId: binding ? legacyAgentAccountId(principal.workspaceId, agent) : null,
            bindingId: binding,
            connected: account?.ready === 1 && account.authExpired === 0,
            running,
            session: session ? snapshot(read(session)) : null,
          };
        }),
        bindings: runnerNamedBindings(db, runnerId, principal.workspaceId)
          .filter((binding) => agents.includes(binding.agent))
          .map((binding) => {
            const session = latestBindingRunnerLoginId(db, {
              runnerId,
              userId: principal.userId,
              bindingId: binding.bindingId,
            });
            return {
              ...binding,
              enabled: binding.enabled === 1,
              held:
                runnerAccountUnsupported(db, runnerId, binding.bindingId, binding.agent) === null,
              running: bindingRunningCount(db, binding.bindingId, now()),
              session: session ? snapshot(read(session)) : null,
            };
          }),
      };
    },
    start(principal: WorkspacePrincipal, runnerId: string, agent: Agent, bindingId?: string) {
      return immediate(db, () => {
        access(principal.workspaceId, principal.userId, runnerId);
        const at = now();
        for (const sessionId of inputs.keys()) read(sessionId);
        const account = bindingId ? namedAccount(principal, runnerId, agent, bindingId) : null;
        const existing = pendingRunnerLoginId(db, {
          runnerId,
          userId: principal.userId,
          agent,
          bindingId: account?.bindingId ?? null,
          at,
        });
        if (existing) return snapshot(read(existing));
        if (account && bindingRunningCount(db, account.bindingId, at) > 0)
          throw new SignInRefused(
            "Work is still running with this account. Let it finish or stop it, then sign in again.",
            409,
          );
        if (pendingRunnerLoginCount(db, runnerId, at) >= 4)
          throw new SignInRefused(
            "This runner already has four sign-ins waiting. Finish one first.",
            429,
          );
        const id = randomUUID();
        const expiresAt = at + SIGN_IN_MS;
        work.enqueue({
          id,
          type: "login",
          runnerId,
          workspaceId: principal.workspaceId,
          agent,
          issuedAt: at,
          expiresAt,
          ...(account ? { account } : {}),
        });
        insertRunnerLogin(db, {
          id,
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          agent,
          expiresAt,
          updatedAt: at,
          bindingId: account?.bindingId ?? null,
        });
        auditWorkspaceAccess(db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "runner.agent_login",
          subject: `${runnerId}/${agent}${account ? `/${account.bindingId}` : ""}`,
          now: at,
        });
        return snapshot(read(id));
      });
    },
    exchange(runnerId: string, id: string, input: RunnerLoginUpdate) {
      const update = RunnerLoginUpdateSchema.parse(input);
      let signedIn: { runnerId: string; agent: Agent } | undefined;
      const reply = immediate(db, () => {
        const row = read(id);
        if (row.runnerId !== runnerId) throw new Error("Login runner changed");
        try {
          access(row.workspaceId, row.userId, runnerId);
        } catch (caughtError1) {
          journalCaught(
            caughtError1,
            "runner-login.exchange.access",
            null,
            "optional file may be absent",
          );
          inputs.delete(id);
          cancelPendingRunnerLogins(db, id);
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
        updateRunnerLogin(db, id, {
          state: update.state,
          terminal,
          authorization:
            !finished && update.authorization ? JSON.stringify(update.authorization) : null,
          inputId: finished ? null : update.inputId,
          updatedAt: now(),
        });
        if (update.state === "connected" && row.bindingId !== null) inputs.delete(id);
        if (update.state === "connected" && row.bindingId === null) {
          setRunnerAgentSignedIn(db, runnerId, row.agent, true);
          wakeRunnerSlotWaits(db, runnerId, now());
          inputs.delete(id);
          signedIn = { runnerId, agent: row.agent };
        }
        if (update.state === "connected") {
          const at = now();
          recordAccountObservation(db, {
            bindingId: row.bindingId ?? legacyAgentBindingId(runnerId, row.agent),
            source: "sign_in",
            sourceId: id,
            observedAt: at,
            now: at,
            state: "ok",
            clears: ["auth"],
          });
        }
        return {
          cancelled: false,
          input: !finished && answer && answer.id === update.inputId ? answer : null,
        };
      });
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
        if (!agent && request.method === "GET") return json(api.list(principal, runnerId));
        if (agent && !id && request.method === "POST") {
          const binding = new URL(request.url).searchParams.get("binding");
          if (binding !== null && !bindingParameter.test(binding))
            return json({ error: "Unsupported agent account request." }, 400);
          return json(api.start(principal, runnerId, agent, binding ?? undefined));
        }
        if (!agent || !id) return json({ error: "Unsupported agent account request." }, 405);
        const row = own(principal, runnerId, agent, id);
        if (!match[4] && request.method === "GET") return json(snapshot(row));
        if (!match[4] && request.method === "DELETE") {
          if (pending(row)) closeRunnerLogin(db, id, "cancelled");
          inputs.delete(id);
          return json(snapshot(read(id)));
        }
        if (match[4] && request.method === "POST") {
          const value = RunnerLoginInputSchema.parse(await body(request));
          const current = own(principal, runnerId, agent, id);
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
          api.exchange(runnerId, match[1]!, RunnerLoginUpdateSchema.parse(await body(request))),
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
