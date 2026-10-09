import { isAbsolute } from "node:path";
import {
  loadEnv,
  privateKeyLooksLikePem,
  type EnvSource,
  type PawsEnv,
  type PawsMode,
} from "./env";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  mode: PawsMode;
  checks: DoctorCheck[];
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MIN_DASHBOARD_TOKEN = 16;

/** Validate the environment. Hosted mode fails closed when a Railway setting is missing. */
export function doctorReport(source: EnvSource = process.env): DoctorReport {
  let env: PawsEnv;
  try {
    env = loadEnv(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      mode: "local",
      checks: [{ name: "env", ok: false, detail }],
    };
  }
  if (!env.hosted) {
    return {
      ok: true,
      mode: "local",
      checks: [
        {
          name: "mode",
          ok: true,
          detail: "local mode; set PAWS_MODE=hosted to validate the Railway environment",
        },
        {
          name: "listen",
          ok: true,
          detail: `${env.host}:${env.port}`,
        },
      ],
    };
  }
  const checks: DoctorCheck[] = [
    homeCheck(source, env),
    bindCheck(env),
    portCheck(source, env),
    publicUrlCheck(env),
    present("LINEAR_CLIENT_ID", env.linearClientId),
    present("LINEAR_CLIENT_SECRET", env.linearClientSecret),
    present("LINEAR_WEBHOOK_SECRET", env.linearWebhookSecret),
    linearTokenCheck(env),
    githubIdCheck("GITHUB_APP_ID", env.githubAppId),
    githubIdCheck("GITHUB_APP_INSTALLATION_ID", env.githubAppInstallationId),
    githubKeyCheck(source, env),
    present("GITHUB_WEBHOOK_SECRET", env.githubWebhookSecret),
    anthropicCheck(env),
    openaiCheck(env),
    dashboardCheck(env),
    {
      name: "ngrok",
      ok: true,
      detail: "skipped in hosted mode; Linear uses the Railway public URL",
    },
    {
      name: "sleep",
      ok: true,
      detail: "laptop keep-awake and sleep detection are disabled",
    },
  ];
  return { ok: checks.every((check) => check.ok), mode: "hosted", checks };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`paws doctor · ${report.mode}`];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "ok" : "fail"}  ${check.name}: ${check.detail}`);
  }
  lines.push(report.ok ? "ready" : "not ready");
  return lines.join("\n");
}

function homeCheck(source: EnvSource, env: PawsEnv): DoctorCheck {
  const explicit = source["PAWS_HOME"];
  const mount = source["RAILWAY_VOLUME_MOUNT_PATH"];
  if (
    (explicit === undefined || explicit.length === 0) &&
    (mount === undefined || mount.length === 0)
  ) {
    return {
      name: "PAWS_HOME",
      ok: false,
      detail: "set PAWS_HOME to the Railway volume mount, for example /data",
    };
  }
  if (!isAbsolute(env.home)) {
    return { name: "PAWS_HOME", ok: false, detail: `${env.home} is not an absolute path` };
  }
  return { name: "PAWS_HOME", ok: true, detail: env.home };
}

function bindCheck(env: PawsEnv): DoctorCheck {
  if (LOOPBACK.has(env.host)) {
    return {
      name: "PAWS_HOST",
      ok: false,
      detail: `${env.host} is not reachable on Railway; use 0.0.0.0`,
    };
  }
  return { name: "PAWS_HOST", ok: true, detail: env.host };
}

function portCheck(source: EnvSource, env: PawsEnv): DoctorCheck {
  const railway = source["PORT"];
  const paws = source["PAWS_PORT"];
  if (
    (railway === undefined || railway.length === 0) &&
    (paws === undefined || paws.length === 0)
  ) {
    return {
      name: "PORT",
      ok: false,
      detail: "Railway sets PORT; PAWS_PORT is the local fallback",
    };
  }
  const from = railway !== undefined && railway.length > 0 ? "PORT" : "PAWS_PORT";
  return { name: "PORT", ok: true, detail: `${env.port} from ${from}` };
}

function publicUrlCheck(env: PawsEnv): DoctorCheck {
  if (env.publicUrl === null) {
    return {
      name: "public url",
      ok: false,
      detail: "set RAILWAY_PUBLIC_DOMAIN or PAWS_PUBLIC_URL",
    };
  }
  if (!env.publicUrl.startsWith("https://")) {
    return { name: "public url", ok: false, detail: "must be https" };
  }
  return { name: "public url", ok: true, detail: env.publicUrl };
}

function linearTokenCheck(env: PawsEnv): DoctorCheck {
  if (env.linearAccessToken !== null || env.linearRefreshToken !== null) {
    return { name: "Linear token", ok: true, detail: "set" };
  }
  return {
    name: "Linear token",
    ok: false,
    detail: "set LINEAR_ACCESS_TOKEN or LINEAR_REFRESH_TOKEN",
  };
}

function githubIdCheck(name: string, value: string | null): DoctorCheck {
  if (value === null) return { name, ok: false, detail: "missing" };
  if (!/^\d+$/.test(value)) return { name, ok: false, detail: "must be numeric" };
  return { name, ok: true, detail: "set" };
}

function githubKeyCheck(source: EnvSource, env: PawsEnv): DoctorCheck {
  if (env.githubAppPrivateKey === null) {
    const path = source["GITHUB_APP_PRIVATE_KEY_PATH"];
    const hint =
      path !== undefined && path.length > 0
        ? "hosted mode reads GITHUB_APP_PRIVATE_KEY from the environment, not a file"
        : "set GITHUB_APP_PRIVATE_KEY to the PEM";
    return { name: "GITHUB_APP_PRIVATE_KEY", ok: false, detail: hint };
  }
  if (!privateKeyLooksLikePem(env.githubAppPrivateKey)) {
    return {
      name: "GITHUB_APP_PRIVATE_KEY",
      ok: false,
      detail: "must be a PEM private key",
    };
  }
  return { name: "GITHUB_APP_PRIVATE_KEY", ok: true, detail: "pem is set" };
}

function anthropicCheck(env: PawsEnv): DoctorCheck {
  if (
    env.anthropicApiKey !== null ||
    env.anthropicAuthToken !== null ||
    env.anthropicBaseUrl !== null ||
    env.modelProxyUrl !== null
  ) {
    return { name: "Anthropic auth", ok: true, detail: "api key or base url is set" };
  }
  return {
    name: "Anthropic auth",
    ok: false,
    detail: "set ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL or PAWS_MODEL_PROXY_URL",
  };
}

function openaiCheck(env: PawsEnv): DoctorCheck {
  if (env.openaiApiKey !== null || env.openaiBaseUrl !== null || env.modelProxyUrl !== null) {
    return { name: "OpenAI auth", ok: true, detail: "api key or base url is set" };
  }
  return {
    name: "OpenAI auth",
    ok: false,
    detail: "set OPENAI_API_KEY or OPENAI_BASE_URL or PAWS_MODEL_PROXY_URL",
  };
}

function dashboardCheck(env: PawsEnv): DoctorCheck {
  if (env.dashboardToken === null) {
    return { name: "PAWS_DASHBOARD_TOKEN", ok: false, detail: "missing" };
  }
  if (env.dashboardToken.length < MIN_DASHBOARD_TOKEN) {
    return {
      name: "PAWS_DASHBOARD_TOKEN",
      ok: false,
      detail: `must be at least ${MIN_DASHBOARD_TOKEN} characters`,
    };
  }
  return { name: "PAWS_DASHBOARD_TOKEN", ok: true, detail: "set" };
}

function present(name: string, value: string | null): DoctorCheck {
  if (value === null) return { name, ok: false, detail: "missing" };
  return { name, ok: true, detail: "set" };
}
