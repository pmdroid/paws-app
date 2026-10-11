import { accessSync, constants, statSync } from "node:fs";
import { GROK_LOGIN_MESSAGE } from "../acp";
import { MISSING_GITHUB_CLIENT_ID_MESSAGE, missingGitHubClientId } from "../auth";
import { loadEnv, pawsPaths, type AgentsConfig, type EnvSource } from "../config";
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
  config?: { agents: AgentsConfig };
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
  linear: "Create a Linear personal API key and run bun run paws setup.",
  mode: "Run bun run paws setup. Comment mode is the default.",
  team: "Run bun run paws setup --linear-team <KEY>.",
  label: "Run bun run paws setup so the paws label exists on the team.",
  ghLogin: "Run gh auth login.",
  ghPush: "Run gh auth login, then grant that login push access to the repository.",
  adapter: "Run bun install in the paws checkout.",
  claude: "Run claude auth login.",
  codex: "Run codex login.",
  closeout: "Fix .agents/closeout.yaml on origin/main.",
  repo: "Run bun run paws setup --repo owner/name.",
  webhook: "Set LINEAR_WEBHOOK_SECRET to the Linear webhook signing secret.",
  publicUrl: "Set PAWS_PUBLIC_URL to the https tunnel origin.",
  ngrok: "Install ngrok and put it on PATH.",
  githubApp: "Set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and a private key at mode 0600.",
  githubLogin: "Run bun run paws login github.",
  githubPush: "Grant this login push access to the repository.",
  githubLabel: "Create the paws label on the repository.",
  githubRate: "Wait for the GitHub rate limit to recover.",
} as const;

/** Prerequisite checks for a real local run. Missing tools are reported, not thrown. */
export function doctorChecks(probe: DoctorProbe, context: DoctorContext = {}): DoctorCheck[] {
  const env = loadEnv(probe.env);
  const paths = pawsPaths(env.home);
  const facts = probe.facts;
  const repoOk = facts.repo !== null && /^[^/\s]+\/[^/\s]+$/.test(facts.repo);
  const githubTracker = facts.trackerKind === "github" || facts.trackerKind === "both";
  const linearTracker = facts.trackerKind !== "github";
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
  if (linearTracker) {
    checks.push(linearCheck(facts), modeCheck(facts), teamCheck(facts));
    if (facts.linearMode === "comments") checks.push(labelCheck(facts));
  }
  if (githubTracker) {
    checks.push(...githubTrackerChecks(facts));
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
  if (facts.webhooks) {
    checks.push(
      check(
        "linear-webhook",
        env.linearWebhookSecret !== null,
        env.linearWebhookSecret !== null ? "secret configured" : "LINEAR_WEBHOOK_SECRET is empty",
        FIX.webhook,
      ),
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

function githubTrackerChecks(facts: ProbeFacts): DoctorCheck[] {
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
    check("github-label", github.label.ok, github.label.detail, FIX.githubLabel),
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
  const label = facts.configured ? facts.linearMode : `${facts.linearMode} (default)`;
  return check("linear-mode", true, label, FIX.mode);
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

function labelCheck(facts: ProbeFacts): DoctorCheck {
  if (!facts.linear.labelFound) {
    const detail = facts.linear.reachable ? "paws label is missing" : "Linear could not be reached";
    return check("linear-label", false, detail, FIX.label);
  }
  return check("linear-label", true, "paws", FIX.label);
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
  const implementer = context.config?.agents.implementer ?? "claude";
  const claudeAcp = check(
    "claude-acp",
    facts.claudeAdapter.ok,
    facts.claudeAdapter.detail,
    FIX.adapter,
  );
  const codexAcp = check(
    "codex-acp",
    facts.codexAdapter.ok,
    facts.codexAdapter.detail,
    FIX.adapter,
  );
  const claude = check("claude", facts.claudeLogin.ok, facts.claudeLogin.detail, FIX.claude);
  const codex = check("codex", facts.codexLogin.ok, facts.codexLogin.detail, FIX.codex);
  if (implementer === "claude") return [claudeAcp, codexAcp, claude, codex];
  const claudeNote = note("claude", `not required when the implementer is ${implementer}`);
  const claudeAcpShown = facts.claudeAdapter.ok
    ? claudeAcp
    : note("claude-acp", `not required when the implementer is ${implementer}`);
  if (implementer === "grok") {
    return [claudeAcpShown, codexAcp, grokCheck(context.grok), claudeNote, codex];
  }
  return [claudeAcpShown, codexAcp, claudeNote, codex];
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

function note(name: string, detail: string): DoctorCheck {
  return { name, ok: true, detail, note: true };
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
