import { isAbsolute, join } from "node:path";
import type { EnvSource, PawsEnv } from "./env";

export type MemberVmConfig = {
  provider: "exe.dev";
  tokenFile: string;
  resources: { cpu: number; memoryGB: number; pool?: string; image?: string };
  runnerVersion: string;
  runnerApiUrl: string;
  serverCaFile?: string;
  mise: { version: string; sha256: { amd64?: string; arm64?: string } };
};

const PREFIX = "PAWS_MEMBER_VM_";

function required(source: EnvSource, name: string): string {
  const value = source[`${PREFIX}${name}`]?.trim();
  if (!value) throw new Error(`${PREFIX}${name} is required when ${PREFIX}PROVIDER is set.`);
  return value;
}

function optional(source: EnvSource, name: string): string | undefined {
  return source[`${PREFIX}${name}`]?.trim() || undefined;
}

function integer(source: EnvSource, name: string, max: number): number {
  const raw = required(source, name);
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value) || value > max)
    throw new Error(`${PREFIX}${name} must be an integer from 1 to ${max}.`);
  return value;
}

function file(env: PawsEnv, value: string): string {
  return isAbsolute(value) ? value : join(env.home, value);
}

export function loadMemberVmConfig(source: EnvSource, env: PawsEnv): MemberVmConfig | null {
  const provider = source[`${PREFIX}PROVIDER`]?.trim();
  if (!provider) {
    const stray = Object.keys(source).find((key) => key.startsWith(PREFIX) && source[key]?.trim());
    if (stray) throw new Error(`${stray} requires ${PREFIX}PROVIDER=exe.dev.`);
    return null;
  }
  if (provider !== "exe.dev") throw new Error(`${PREFIX}PROVIDER must be exe.dev.`);
  const runnerVersion = required(source, "RUNNER_VERSION");
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(runnerVersion))
    throw new Error(`${PREFIX}RUNNER_VERSION must look like 1.2.3.`);
  const runnerApiUrl = required(source, "RUNNER_API_URL");
  const url = URL.parse(runnerApiUrl);
  if (!url || url.protocol !== "https:" || url.origin !== runnerApiUrl.replace(/\/$/, ""))
    throw new Error(`${PREFIX}RUNNER_API_URL must be an HTTPS origin the VM can reach.`);
  const pool = optional(source, "POOL");
  const image = optional(source, "IMAGE");
  if (pool !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(pool))
    throw new Error(`${PREFIX}POOL is not a valid exe.dev pool name.`);
  if (image !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,511}$/.test(image))
    throw new Error(`${PREFIX}IMAGE is not a valid image reference.`);
  const miseVersion = required(source, "MISE_VERSION");
  if (!/^[0-9]{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9][0-9]*)$/.test(miseVersion))
    throw new Error(`${PREFIX}MISE_VERSION must be a mise release such as 2026.10.15.`);
  const amd64 = optional(source, "MISE_SHA256_AMD64");
  const arm64 = optional(source, "MISE_SHA256_ARM64");
  if (amd64 === undefined && arm64 === undefined)
    throw new Error(`${PREFIX}MISE_SHA256_AMD64 or ${PREFIX}MISE_SHA256_ARM64 is required.`);
  for (const [name, value] of [
    ["MISE_SHA256_AMD64", amd64],
    ["MISE_SHA256_ARM64", arm64],
  ] as const)
    if (value !== undefined && !/^[0-9a-f]{64}$/.test(value))
      throw new Error(`${PREFIX}${name} must be a lowercase SHA-256 hex digest.`);
  const serverCa = optional(source, "SERVER_CA_FILE");
  return {
    provider,
    tokenFile: file(env, optional(source, "TOKEN_FILE") ?? join("secrets", "exe-dev-token")),
    resources: {
      cpu: integer(source, "CPU", 512),
      memoryGB: integer(source, "MEMORY_GB", 4096),
      ...(pool === undefined ? {} : { pool }),
      ...(image === undefined ? {} : { image }),
    },
    runnerVersion,
    runnerApiUrl: url.origin,
    ...(serverCa === undefined ? {} : { serverCaFile: file(env, serverCa) }),
    mise: {
      version: miseVersion,
      sha256: {
        ...(amd64 === undefined ? {} : { amd64 }),
        ...(arm64 === undefined ? {} : { arm64 }),
      },
    },
  };
}
