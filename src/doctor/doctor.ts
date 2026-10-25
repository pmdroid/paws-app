import { accessSync, constants, statSync } from "node:fs";
import { GROK_LOGIN_MESSAGE } from "../acp";
import { MISSING_GITHUB_CLIENT_ID_MESSAGE, missingGitHubClientId } from "../auth";
import {
  LINEAR_COMMENT_MODE_REMOVED,
  LINEAR_WORKSPACE_REQUIRED,
  loadEnv,
  pawsPaths,
  type EnvSource,
  type ExeDevTokenStatus,
} from "../config";
import { describeLinearWebhookWarning, LINEAR_WEBHOOK_FIX, type LinearWebhookWarning } from "../db";
import { doctorAgentProfiles, type DoctorAgentConfig } from "./agents";
import type { GrokLoginStatus } from "../install";
import { realProbeFacts, type GitHubDoctorFacts, type ProbeFacts } from "./probe";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** One next step. Printed only when the check is missing. */
  fix?: string;
  /** Shown, and does not fail `paws doctor`. */
  note?: boolean;
};

export type DoctorContext = {
  config?: DoctorAgentConfig;
  /** Login probe for `agents.implementer = grok`. */
  grok?: GrokLoginStatus | null;
};

export type DoctorProbe = {
  which(bin: string): string | null;
  stat(path: string): { mode: number } | null;
  canWrite(dir: string): boolean;
  bunVersion: string | null;
  env: EnvSource;
  facts: ProbeFacts;
};

const FIX = {
  git: "Install git and put it on PATH.",
  bun: "Install Bun 1.4 or newer and run this process with bun.",
  home: "Create ~/.paws and make sure this user can write it.",
  linear: "Open Paws in your browser and connect Linear.",
  mode: "Connect your Linear workspace in the Paws website.",
  team: "Choose the Linear teams in workspace settings.",
  workspace: LINEAR_WORKSPACE_REQUIRED,
  commentMode: LINEAR_COMMENT_MODE_REMOVED,
  ghLogin: "Run gh auth login.",
  ghPush: "Run gh auth login, then grant that login push access to the repository.",
  adapter: "Run bun install in the paws checkout.",
  claude: "Run claude auth login.",
  codex: "Run codex login.",
  closeout: "Fix .agents/closeout.yaml on origin/main.",
  repo: "Connect GitHub and choose repositories in workspace settings.",
  webhook: "Set LINEAR_WEBHOOK_SECRET to the Linear webhook signing secret.",
  publicUrl: "Set PAWS_PUBLIC_URL to the https tunnel origin.",
  ngrok: "Install ngrok and put it on PATH.",
  githubApp: "Set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and a private key at mode 0600.",
  githubLogin: "Run bun run paws login github.",
  githubPush: "Grant this login push access to the repository.",
  githubRate: "Wait for the GitHub rate limit to recover.",
  exeDev:
    "Generate an exe.dev API token that may run new, ls and ssh, and save it to ~/.paws/secrets/exe-dev-token.",
  githubWebhook:
    "Enable the GitHub App webhook at PAWS_PUBLIC_URL/webhooks/github with GITHUB_WEBHOOK_SECRET and the Check runs, Check suites, Statuses, Pull requests, Pull request reviews and Merge groups events (docs/github-login.md).",
} as const;

/** Prerequisite checks for a real local run. Missing tools are reported, not thrown. */
export function doctorChecks(probe: DoctorProbe, context: DoctorContext = {}): DoctorCheck[] {
  const env = loadEnv(probe.env);
  const paths = pawsPaths(env.home);
  const facts = probe.facts;
  const repoOk = facts.repo !== null && /^[^/\s]+\/[^/\s]+$/.test(facts.repo);
  const checks: DoctorCheck[] = [
    check("git", probe.which("git") !== null, probe.which("git") ?? "git is not on PATH", FIX.git),
    check(
      "bun",
      probe.bunVersion !== null,
      probe.bunVersion ?? "bun is not running this process",
      FIX.bun,
    ),
    check(
      "home",
      probe.canWrite(paths.home),
      probe.canWrite(paths.home) ? paths.home : `cannot write ${paths.home}`,
      FIX.home,
    ),
  ];
  {
    checks.push(
      linearCheck(facts),
      modeCheck(facts),
      workspaceCheck(probe.env, facts),
      teamCheck(facts),
    );
  }
  if (facts.githubAuth !== "gh") {
    checks.push(...githubAuthChecks(facts));
  } else {
    checks.push(
      check("gh-login", facts.ghLogin.ok, facts.ghLogin.detail, FIX.ghLogin),
      check(
        "gh-push",
        facts.ghPush.ok,
        facts.ghPush.detail,
        facts.ghPush.ok ? undefined : ghPushFix(facts),
      ),
    );
  }
  checks.push(
    ...agentChecks(facts, context),
    closeoutCheck(facts),
    check(
      "repository",
      repoOk,
      repoOk ? (facts.repo ?? "") : "repository must be owner/name",
      FIX.repo,
    ),
  );
  if (facts.exeDevToken !== undefined) checks.push(exeDevCheck(facts.exeDevToken));
  if (facts.webhooks) {
    checks.push(
      check(
        "linear-webhook",
        env.linearWebhookSecret !== null,
        env.linearWebhookSecret !== null ? "secret configured" : "LINEAR_WEBHOOK_SECRET is empty",
        FIX.webhook,
      ),
      ...(facts.linearWebhook === undefined ? [] : [webhookDeliveryCheck(facts.linearWebhook)]),
      check(
        "public-url",
        facts.publicUrl !== null && facts.publicUrl.startsWith("https://"),
        facts.publicUrl ?? "PAWS_PUBLIC_URL must be the https tunnel origin",
        FIX.publicUrl,
      ),
      check(
        "ngrok",
        probe.which("ngrok") !== null,
        probe.which("ngrok") ?? "ngrok is not on PATH",
        FIX.ngrok,
      ),
    );
  }
  if (facts.webhooks || env.githubWebhookSecret !== null || facts.githubDelivery) {
    const delivery = facts.githubDelivery ?? null;
    checks.push(
      check(
        "github-webhook",
        delivery !== null,
        delivery === null
          ? "no signed GitHub webhook delivery has arrived"
          : `last ${delivery.event} delivery at ${new Date(delivery.receivedAt).toISOString()}`,
        FIX.githubWebhook,
      ),
    );
  }
  if (facts.githubAuth === "app") {
    checks.push(
      githubAppCheck(
        probe,
        env.githubAppId,
        env.githubAppInstallationId,
        env.githubAppPrivateKeyPath,
      ),
    );
  }
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const lines = ["paws doctor"];
  for (const item of checks) {
    const label = item.note ? "note" : item.ok ? "ok" : "missing";
    lines.push(`${label} ${item.name}: ${item.detail}`);
    if (!item.ok && item.fix) lines.push(`  fix: ${item.fix}`);
  }
  return lines.join("\n");
}

export async function realProbe(env: EnvSource = process.env): Promise<DoctorProbe> {
  const facts = await realProbeFacts(env);
  return {
    env,
    facts,
    bunVersion: typeof Bun === "undefined" ? null : Bun.version,
    which(bin) {
      const command = bin.split(/\s+/)[0];
      if (command === undefined || command.length === 0) return null;
      return Bun.which(command);
    },
    stat(path) {
      try {
        return { mode: statSync(path).mode };
      } catch {
        return null;
      }
    },
    canWrite(dir) {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function githubAuthChecks(facts: ProbeFacts): DoctorCheck[] {
  if (
    facts.githubAuth === "oauth" &&
    (facts.githubDoctor.placeholder || missingGitHubClientId(facts.oauthClientId))
  ) {
    return [
      check(
        "github-auth",
        false,
        MISSING_GITHUB_CLIENT_ID_MESSAGE,
        MISSING_GITHUB_CLIENT_ID_MESSAGE,
      ),
    ];
  }
  const github = facts.githubDoctor;
  const loginFix = facts.githubAuth === "gh" ? FIX.ghLogin : FIX.githubLogin;
  const checks: DoctorCheck[] = [
    check("github-auth", github.signedIn.ok, github.signedIn.detail, loginFix),
    tokenStoreCheck(github),
    check(
      "github-push",
      github.push.ok,
      github.push.detail,
      github.push.ok ? undefined : FIX.githubPush,
    ),
    check("github-rate", github.rate.ok, github.rate.detail, FIX.githubRate),
  ];
  return checks;
}

function tokenStoreCheck(github: GitHubDoctorFacts): DoctorCheck {
  if (github.storeKind === "file") {
    return {
      name: "github-token-store",
      ok: true,
      note: true,
      detail: github.storeWarning ?? "token file",
    };
  }
  return check("github-token-store", true, github.storeKind);
}

function linearCheck(facts: ProbeFacts): DoctorCheck {
  if (facts.configError !== null) {
    return check("linear", false, facts.configError, FIX.mode);
  }
  if (!facts.linear.attempted) {
    return check("linear", false, "no Linear credential", FIX.linear);
  }
  if (!facts.linear.reachable) {
    return check("linear", false, facts.linear.error ?? "Linear could not be reached", FIX.linear);
  }
  if (!facts.linear.viewerMatches) {
    return check("linear", false, "viewer id does not match config.toml", FIX.linear);
  }
  const viewer = facts.linear.viewerId ?? "viewer";
  return check("linear", true, `viewer ${viewer}`, FIX.linear);
}

function modeCheck(facts: ProbeFacts): DoctorCheck {
  if (facts.configError !== null) {
    return check("linear-mode", false, facts.configError, FIX.mode);
  }
  if (facts.linearCommentMode)
    return check("linear-mode", false, "comment mode is configured", FIX.commentMode);
  return check("linear-mode", true, "agent-session", FIX.mode);
}

function workspaceCheck(env: EnvSource, facts: ProbeFacts): DoctorCheck {
  if (env.PAWS_PUBLIC_DASHBOARD !== "1")
    return check("linear-workspace", false, "PAWS_PUBLIC_DASHBOARD is not 1", FIX.workspace);
  if (!facts.workspace)
    return check(
      "linear-workspace",
      false,
      "no Linear workspace admin has signed in",
      FIX.workspace,
    );
  return check("linear-workspace", true, facts.workspace);
}

function teamCheck(facts: ProbeFacts): DoctorCheck {
  if (facts.team === null && facts.teamId === null) {
    return check("linear-team", false, "no Linear team configured", FIX.team);
  }
  if (!facts.linear.teamFound) {
    const detail = facts.linear.reachable ? "team was not found" : "Linear could not be reached";
    return check("linear-team", false, detail, FIX.team);
  }
  return check("linear-team", true, facts.team ?? facts.teamId ?? "team", FIX.team);
}

function closeoutCheck(facts: ProbeFacts): DoctorCheck {
  if (facts.closeout.ok) return check("closeout", true, facts.closeout.detail);
  return check("closeout", false, facts.closeout.detail, facts.closeout.fix ?? FIX.closeout);
}

function githubAppCheck(
  probe: DoctorProbe,
  appId: string | null,
  installationId: string | null,
  keyPath: string | null,
): DoctorCheck {
  const keyStat = keyPath === null ? null : probe.stat(keyPath);
  const mode = keyStat === null ? null : keyStat.mode & 0o777;
  const ok =
    appId !== null &&
    installationId !== null &&
    keyStat !== null &&
    (mode === 0o600 || mode === 0o400);
  return check(
    "github-app",
    ok,
    githubDetail(appId, installationId, keyStat !== null, mode),
    FIX.githubApp,
  );
}

function ghPushFix(facts: ProbeFacts): string {
  if (facts.repo === null) return FIX.repo;
  return FIX.ghPush;
}

function agentChecks(facts: ProbeFacts, context: DoctorContext): DoctorCheck[] {
  const profiles = context.config
    ? doctorAgentProfiles(context.config)
    : (facts.agentProfiles ?? doctorAgentProfiles());
  const agents = new Set(
    profiles.flatMap((profile) => [profile.implementer.agent, profile.reviewer.agent]),
  );
  const unused = "not required by configured agent profiles";
  const checks = [
    agents.has("claude")
      ? check("claude-acp", facts.claudeAdapter.ok, facts.claudeAdapter.detail, FIX.adapter)
      : note("claude-acp", unused),
    agents.has("codex")
      ? check("codex-acp", facts.codexAdapter.ok, facts.codexAdapter.detail, FIX.adapter)
      : note("codex-acp", unused),
  ];
  if (agents.has("grok")) checks.push(grokCheck(context.grok ?? facts.grokLogin));
  checks.push(
    agents.has("claude")
      ? check("claude", facts.claudeLogin.ok, facts.claudeLogin.detail, FIX.claude)
      : note("claude", unused),
    agents.has("codex")
      ? check("codex", facts.codexLogin.ok, facts.codexLogin.detail, FIX.codex)
      : note("codex", unused),
  );
  return checks;
}

function grokCheck(status: GrokLoginStatus | null | undefined): DoctorCheck {
  if (status == null || !status.installed || !status.loggedIn) {
    return check(
      "grok",
      false,
      status?.detail && status.detail.length > 0 ? status.detail : GROK_LOGIN_MESSAGE,
    );
  }
  return check("grok", true, status.detail);
}

function exeDevCheck(status: ExeDevTokenStatus): DoctorCheck {
  switch (status) {
    case "readable":
      return check("exe-dev", true, "token present and readable");
    case "absent":
      return note("exe-dev", "no exe.dev token; Paws cannot create runner VMs");
    case "empty":
      return check("exe-dev", false, "exe.dev token file is empty", FIX.exeDev);
    case "unreadable":
      return check("exe-dev", false, "exe.dev token file cannot be read", FIX.exeDev);
  }
}

function note(name: string, detail: string): DoctorCheck {
  return { name, ok: true, detail, note: true };
}

function webhookDeliveryCheck(warning: LinearWebhookWarning | null): DoctorCheck {
  return warning === null
    ? check("linear-webhook-delivery", true, "no sign Linear disabled the webhook")
    : check(
        "linear-webhook-delivery",
        false,
        describeLinearWebhookWarning(warning),
        LINEAR_WEBHOOK_FIX,
      );
}

function check(name: string, ok: boolean, detail: string, fix?: string): DoctorCheck {
  return fix === undefined ? { name, ok, detail } : { name, ok, detail, fix };
}

function githubDetail(
  appId: string | null,
  installationId: string | null,
  keyExists: boolean,
  mode: number | null,
): string {
  if (appId === null || installationId === null)
    return "GitHub App id and installation id are required";
  if (!keyExists) return "GitHub App private key file is missing";
  if (mode !== 0o600 && mode !== 0o400) return "GitHub App private key must be mode 0600";
  return "app configured";
}
