import {
  auditWorkspaceAccessSteps,
  claimGithubOAuthSteps,
  deleteCredentialCiphertextSteps,
  completeGithubOAuthSteps,
  failGithubOAuthSteps,
  githubOAuthStateExistsSteps,
  insertGithubOAuthSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type Q,
  type Steps,
} from "../db";
import {
  isWorkspaceAdmin,
  requestWorkspaceSessionSteps,
  validWorkspaceCsrf,
  workspaceSecret,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../workspace";
import { dashboardUrl } from "../dashboard-links";
import { journalCaught } from "../journal";
import {
  installedSlackTokenSteps,
  slackTeamOwnerSteps,
  requestSlackToken,
  resolveSlackApp,
  saveInstalledSlackTokenSteps,
  type SlackFetch,
  type SlackToken,
} from "./oauth";
import { SLACK_CALLBACK_PATH, SLACK_INSTALL_SCOPES, slackCapabilities } from "./manifest";

const STATUS = "/api/workspaces/slack";
const CONNECT = "/api/workspaces/slack/connect";
const IDENTITY = ["teamId", "teamName", "appId", "botUserId"];

export function createSlackConnect(options: {
  store: Db;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  fetch?: SlackFetch;
  now?: () => number;
}) {
  const { store, home, env } = options;
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  const slackFetch = options.fetch ?? fetch;
  const redirectUri = origin + SLACK_CALLBACK_PATH;
  const back = (code: string) =>
    redirect(`${dashboardUrl(origin, "/workspace/integrations")}?slack=${code}`);
  function* adminSteps(q: Q, principal: WorkspacePrincipal): Steps<boolean> {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    return workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
  }
  const auditSteps = (q: Q, principal: WorkspacePrincipal, action: string, subject = "slack") =>
    auditWorkspaceAccessSteps(q, { ...principal, action, subject, now: now() });

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (![STATUS, CONNECT, SLACK_CALLBACK_PATH].includes(url.pathname)) return null;
    const access = await store.run((q) => requestWorkspaceSessionSteps(q, request, now()));
    const principal = access?.principal;
    if (url.pathname === SLACK_CALLBACK_PATH) {
      if (!principal) return back("forbidden");
      return callback(url, principal, access!.session.tokenHash);
    }
    const unsafe = request.method !== "GET";
    if (
      !principal ||
      !(await store.run((q) => adminSteps(q, principal))) ||
      (unsafe &&
        (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access!.session)))
    ) {
      if (principal)
        await store.run((q) => auditSteps(q, principal, "access.denied", url.pathname));
      return json({ error: "Ask a workspace admin to connect Slack." }, principal ? 403 : 401);
    }
    if (url.pathname === STATUS && request.method === "GET") return json(await status(principal));
    if (url.pathname === STATUS && request.method === "DELETE") return disconnect(principal);
    if (url.pathname === CONNECT && request.method === "POST")
      return connect(principal, access!.session.tokenHash);
    return json({ error: "Method not allowed." }, 405);
  };

  async function status(principal: WorkspacePrincipal) {
    const token = await store.run((q) => installedSlackTokenSteps(q, home, principal.workspaceId));
    return {
      configured: resolveSlackApp(home, env) !== null,
      redirectUrl: redirectUri,
      eventsUrl: `${origin}/webhooks/slack`,
      connection: token ? JSON.parse(JSON.stringify(token, IDENTITY)) : null,
      capabilities: token ? slackCapabilities(token.scope) : null,
    };
  }

  async function connect(principal: WorkspacePrincipal, sessionHash: string) {
    const app = resolveSlackApp(home, env);
    if (!app) return json({ error: "Set the Slack app credentials on the server first." }, 409);
    const state = workspaceSecret();
    await store.transaction(function* (q) {
      const current = yield* installedSlackTokenSteps(q, home, principal.workspaceId);
      yield* insertGithubOAuthSteps(q, {
        stateHash: workspaceTokenHash(state),
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        sessionHash,
        secretId: "slack",
        expectedGeneration: current?.updatedAt ?? 0,
        intent: JSON.stringify({ kind: "slack" }),
        expiresAt: now() + 10 * 60_000,
      });
      yield* auditSteps(q, principal, "slack.started");
    });
    const scope = SLACK_INSTALL_SCOPES.join(",");
    const query = new URLSearchParams({
      client_id: app.clientId,
      scope,
      state,
      redirect_uri: redirectUri,
    });
    return json({ url: `https://slack.com/oauth/v2/authorize?${query}` });
  }

  async function callback(url: URL, principal: WorkspacePrincipal, sessionHash: string) {
    const state = url.searchParams.get("state") ?? "";
    const hash = workspaceTokenHash(state);
    const claimed = await store.run(function* (q) {
      if (state.length > 128 || !(yield* githubOAuthStateExistsSteps(q, hash, "slack"))) return;
      return yield* claimGithubOAuthSteps(q, hash, { ...principal, sessionHash }, now());
    });
    if (!claimed) return back("expired");
    const fail = async (code: string) => {
      await store.transaction(function* (q) {
        yield* failGithubOAuthSteps(q, claimed.state_hash, true);
        yield* auditSteps(q, principal, `slack.${code}`);
      });
      return back(code);
    };
    if (!(await store.run((q) => adminSteps(q, principal)))) return fail("forbidden");
    if (url.searchParams.has("error")) return fail("denied");
    const code = url.searchParams.get("code");
    const app = resolveSlackApp(home, env);
    if (!code || !app) return fail("failed");
    let token: SlackToken;
    try {
      const body = new URLSearchParams({ code, redirect_uri: redirectUri });
      const signal = AbortSignal.timeout(15_000);
      token = await requestSlackToken(app, body, slackFetch, signal, undefined, []);
      if (!token.appId || (env.SLACK_APP_ID && token.appId !== env.SLACK_APP_ID))
        throw new Error("Slack returned a different app.");
      if (token.refreshToken !== null) return fail("rotating");
    } catch (caught) {
      journalCaught(caught, "slack.connect.exchange", null);
      return fail("failed");
    }
    const saved = await store.transaction(function* (q) {
      if (!(yield* adminSteps(q, principal))) return "forbidden";
      const current = yield* installedSlackTokenSteps(q, home, principal.workspaceId);
      const expected = claimed.expected_generation;
      if ((current?.updatedAt ?? 0) !== expected) return "conflict";
      if (current && (current.teamId !== token.teamId || current.appId !== token.appId))
        return "different_team";
      const team = yield* slackTeamOwnerSteps(q, home, token.teamId, principal.workspaceId);
      if (team.owner?.value !== principal.workspaceId) return "team_taken";
      if (!(yield* saveInstalledSlackTokenSteps(q, home, principal.workspaceId, token, expected)))
        return "conflict";
      yield* completeGithubOAuthSteps(q, claimed.state_hash);
      yield* auditSteps(q, principal, "slack.connected", `slack:${token.teamId}`);
      return "connected";
    });
    return saved === "connected" ? back(saved) : fail(saved);
  }

  async function disconnect(principal: WorkspacePrincipal) {
    const ended = await store.transaction(function* (q) {
      const current = yield* installedSlackTokenSteps(q, home, principal.workspaceId);
      const key = { kind: "slack" as const, workspace: principal.workspaceId };
      if (!current || !(yield* deleteCredentialCiphertextSteps(q, key, current.updatedAt)))
        return null;
      const team = yield* slackTeamOwnerSteps(q, home, current.teamId);
      if (team.owner) yield* deleteCredentialCiphertextSteps(q, team.key, team.owner.updatedAt);
      yield* auditSteps(q, principal, "slack.disconnected", `slack:${current.teamId}`);
      return current;
    });
    if (!ended) return json({ error: "Slack is not connected, or it just changed." }, 409);
    await slackFetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${ended.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch((caught: unknown) => journalCaught(caught, "slack.connect.revoke", null));
    return json({ ok: true });
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
