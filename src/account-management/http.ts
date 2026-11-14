import { z } from "zod";
import {
  AgentAccountError,
  agentAccountOverviewSteps,
  centralSignInTargetSteps,
  createAgentAccountSteps,
  orderAgentAccountsSteps,
  setAgentAccountExtraUsageSteps,
  signOutAgentAccountSteps,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import { RUNNER_CODING_AGENTS } from "../runner-protocol";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";

const RETIRED = /^\/api\/runners\/accounts(?:\/.*)?$/;
const CENTRAL =
  /^\/api\/runners\/agent-accounts(?:\/(order)|\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(extra-usage|sign-in|credential))?$/;

export const AGENT_ACCOUNTS_RETIRED =
  "Agent accounts were replaced by per-runner sign-in on the Runners page";

const agent = z.enum(RUNNER_CODING_AGENTS);
const Create = z.strictObject({ agent, label: z.string().trim().min(1).max(80) });
const Order = z.strictObject({ agent, ids: z.array(z.string().min(1).max(128)).max(64) });
const ExtraUsage = z.strictObject({ extraUsage: z.boolean() });

const STATUS: Record<string, number> = {
  not_found: 404,
  foreign_workspace: 404,
  removed: 404,
  duplicate: 409,
  runner_unsupported: 409,
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function createAccountManagement(options: { store?: Db; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  return async function browser(
    request: Request,
    principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (RETIRED.test(path)) return json({ error: AGENT_ACCOUNTS_RETIRED }, 410);
    const match = CENTRAL.exec(path);
    if (!match || !options.store) return null;
    const { store } = options;
    const { workspaceId } = principal;
    const [, order, accountId, action] = match;
    const method = request.method;
    const admin = isWorkspaceAdmin(principal.role);
    try {
      if (!order && !accountId && method === "GET") {
        const accounts = await store.run((q) => agentAccountOverviewSteps(q, workspaceId, now()));
        return json({ canManage: admin, accounts });
      }
      if (method === "GET") return json({ error: "Unsupported agent account request." }, 405);
      if (!admin) return json({ error: "Only workspace admins can change agent accounts." }, 403);
      if (!order && !accountId && method === "POST") {
        const input = Create.parse(await request.json());
        const account = await store.transaction((q) =>
          createAgentAccountSteps(q, { workspaceId, ...input, now: now() }),
        );
        return json({ id: account.id, agent: account.agent, label: account.label }, 201);
      }
      if (order && method === "PUT") {
        const input = Order.parse(await request.json());
        await store.transaction((q) =>
          orderAgentAccountsSteps(q, { workspaceId, ...input, now: now() }),
        );
        return json({ ok: true });
      }
      if (action === "extra-usage" && method === "PUT") {
        const { extraUsage } = ExtraUsage.parse(await request.json());
        await store.transaction((q) =>
          setAgentAccountExtraUsageSteps(q, {
            workspaceId,
            accountId: accountId!,
            extraUsage,
            now: now(),
          }),
        );
        return json({ ok: true });
      }
      if (action === "sign-in" && method === "POST")
        return json(
          await store.transaction((q) =>
            centralSignInTargetSteps(q, {
              workspaceId,
              userId: principal.userId,
              accountId: accountId!,
              now: now(),
            }),
          ),
        );
      if (action === "credential" && method === "DELETE") {
        await store.transaction((q) =>
          signOutAgentAccountSteps(q, { workspaceId, accountId: accountId!, now: now() }),
        );
        return json({ ok: true });
      }
      return json({ error: "Unsupported agent account request." }, 405);
    } catch (error) {
      if (error instanceof AgentAccountError)
        return json({ error: error.message }, STATUS[error.code] ?? 400);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: "The agent account request is invalid." }, 400);
      journalCaught(error, "account-management.browser", null);
      return json({ error: "Agent accounts are unavailable. Refresh to try again." }, 500);
    }
  };
}
