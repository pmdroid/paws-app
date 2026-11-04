import {
  workspaceMemberUsable,
  AgentAccountError,
  auditWorkspaceAccess,
  getAgentAccount,
  getAgentBinding,
  getRunner,
  immediate,
  legacyAgentAccountId,
  legacyAgentBindingId,
  recordAccountObservation,
  runnerAccountUnsupported,
  runnerLeaseCutoff,
  workspaceMember,
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

type Agent = "claude" | "codex" | "grok" | "opencode";
type Row = {
  id: string;
  runnerId: string;
  workspaceId: string;
  userId: string;
  agent: Agent;
  state: "starting" | "waiting" | "connected" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  terminal: string;
  authorization: string | null;
  inputId: string | null;
  bindingId: string | null;
};
const columns =
  "id,runner_id AS runnerId,workspace_id AS workspaceId,user_id AS userId,agent,state,expires_at AS expiresAt,terminal,authorization,input_id AS inputId,binding_id AS bindingId";
const bindingParameter = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
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
    const row = db.query<Row, [string]>(`SELECT ${columns} FROM runner_login WHERE id=?`).get(id);
    if (!row) throw new Error("Login session is unavailable");
    if (pending(row) && row.expiresAt <= now()) {
      db.run(
        "UPDATE runner_login SET state='expired',terminal='',authorization=NULL,input_id=NULL WHERE id=?",
        [id],
      );
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
  function bindingRunning(bindingId: string, at: number) {
    return db
      .query<{ count: number }, [string, number, number]>(
        `SELECT (SELECT COUNT(*) FROM runner_work w JOIN runner_command_account c ON c.command_id=w.command_id
            WHERE c.binding_id=?1 AND w.ended_at IS NULL AND w.lease_until>?2)
          + (SELECT COUNT(*) FROM runner_helper h JOIN runner_command_account c ON c.command_id=h.id
            WHERE c.binding_id=?1 AND h.ended_at IS NULL AND h.result IS NULL AND h.expires_at>?3) AS count`,
      )
      .get(bindingId, runnerLeaseCutoff(at), at)!.count;
  }
  const api = {
    stop() {
      inputs.clear();
      db.run(
        "UPDATE runner_login SET state='cancelled',terminal='',authorization=NULL,input_id=NULL WHERE state IN ('starting','waiting')",
      );
    },
    list(principal: WorkspacePrincipal, runnerId: string) {
      access(principal.workspaceId, principal.userId, runnerId);
      const agents = (["claude", "codex", "grok", "opencode"] as const).filter((agent) =>
        work.supportsAgent(runnerId, agent),
      );
      return {
        accounts: agents.map((agent) => {
          const account = db
            .query<{ connected: number }, [string, string]>(
              "SELECT ready=1 AND auth_expired=0 AS connected FROM runner_agent_policy WHERE runner_id=? AND agent=?",
            )
            .get(runnerId, agent);
          const session = db
            .query<{ id: string }, [string, string, string]>(
              "SELECT id FROM runner_login WHERE runner_id=? AND user_id=? AND agent=? AND binding_id IS NULL ORDER BY rowid DESC LIMIT 1",
            )
            .get(runnerId, principal.userId, agent);
          // Sign-in replaces the credentials these tasks read from their next request on.
          const running = db
            .query<{ count: number }, [string, string, number]>(
              "SELECT COUNT(*) AS count FROM runner_work JOIN run ON run.id=runner_work.run_id WHERE runner_work.runner_id=? AND run.agent=? AND runner_work.ended_at IS NULL AND runner_work.lease_until>?",
            )
            .get(runnerId, agent, runnerLeaseCutoff(now()))!.count;
          const binding = db
            .query<{ id: string }, [string]>("SELECT id FROM agent_account_binding WHERE id=?")
            .get(legacyAgentBindingId(runnerId, agent));
          return {
            agent,
            accountId: binding ? legacyAgentAccountId(principal.workspaceId, agent) : null,
            bindingId: binding?.id ?? null,
            connected: account?.connected === 1,
            running,
            session: session ? snapshot(read(session.id)) : null,
          };
        }),
        bindings: db
          .query<
            {
              bindingId: string;
              accountId: string;
              agent: Agent;
              label: string;
              enabled: number;
            },
            [string, string]
          >(
            "SELECT b.id AS bindingId,b.account_id AS accountId,b.agent,a.label,a.enabled FROM agent_account_binding b JOIN agent_account a ON a.id=b.account_id WHERE b.runner_id=? AND b.workspace_id=? AND b.legacy=0 AND b.removed_at IS NULL AND a.removed_at IS NULL ORDER BY a.agent,a.created_at,b.created_at",
          )
          .all(runnerId, principal.workspaceId)
          .filter((binding) => agents.includes(binding.agent))
          .map((binding) => {
            const session = db
              .query<{ id: string }, [string, string, string]>(
                "SELECT id FROM runner_login WHERE runner_id=? AND user_id=? AND binding_id=? ORDER BY rowid DESC LIMIT 1",
              )
              .get(runnerId, principal.userId, binding.bindingId);
            return {
              ...binding,
              enabled: binding.enabled === 1,
              held:
                runnerAccountUnsupported(db, runnerId, binding.bindingId, binding.agent) === null,
              running: bindingRunning(binding.bindingId, now()),
              session: session ? snapshot(read(session.id)) : null,
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
        const existing = db
          .query<{ id: string }, [string, string, string, string | null, number]>(
            "SELECT id FROM runner_login WHERE runner_id=? AND user_id=? AND agent=? AND binding_id IS ? AND state IN ('starting','waiting') AND expires_at>?",
          )
          .get(runnerId, principal.userId, agent, account?.bindingId ?? null, at);
        if (existing) return snapshot(read(existing.id));
        if (account && bindingRunning(account.bindingId, at) > 0)
          throw new SignInRefused(
            "Work is still running with this account. Let it finish or stop it, then sign in again.",
            409,
          );
        const count = db
          .query<{ count: number }, [string, number]>(
            "SELECT COUNT(*) AS count FROM runner_login WHERE runner_id=? AND state IN ('starting','waiting') AND expires_at>?",
          )
          .get(runnerId, at)!.count;
        if (count >= 4)
          throw new SignInRefused(
            "This runner already has four sign-ins waiting. Finish one first.",
            429,
          );
        const id = randomUUID();
        const expiresAt = at + 600_000;
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
        db.run(
          "INSERT INTO runner_login(id,runner_id,workspace_id,user_id,agent,state,expires_at,updated_at,binding_id) VALUES(?,?,?,?,?,'starting',?,?,?)",
          [
            id,
            runnerId,
            principal.workspaceId,
            principal.userId,
            agent,
            expiresAt,
            at,
            account?.bindingId ?? null,
          ],
        );
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
          db.run(
            "UPDATE runner_login SET state='cancelled',terminal='',authorization=NULL,input_id=NULL WHERE id=? AND state IN ('starting','waiting')",
            [id],
          );
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
        db.run(
          "UPDATE runner_login SET state=?,terminal=?,authorization=?,input_id=?,updated_at=? WHERE id=?",
          [
            update.state,
            terminal,
            !finished && update.authorization ? JSON.stringify(update.authorization) : null,
            finished ? null : update.inputId,
            now(),
            id,
          ],
        );
        if (update.state === "connected" && row.bindingId !== null) inputs.delete(id);
        if (update.state === "connected" && row.bindingId === null) {
          db.run(
            "INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1) ON CONFLICT(runner_id,agent) DO UPDATE SET ready=1,auth_expired=0",
            [runnerId, row.agent],
          );
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
          if (pending(row))
            db.run(
              "UPDATE runner_login SET state='cancelled',terminal='',authorization=NULL,input_id=NULL WHERE id=?",
              [id],
            );
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
