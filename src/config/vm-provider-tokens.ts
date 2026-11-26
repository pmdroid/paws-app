import { join } from "node:path";
import { readSecretFile, secretFileExists } from "../credentials";
import { journalCaught } from "../journal";
import { exeDevTokenPath, type ExeDevTokenStatus } from "./exe-dev";
import { memberVmProvider, type MemberVmProviderName, type VmSizes } from "./vm-sizes";
import { pawsPaths } from "./paths";

export function boatTokenPath(home: string): string {
  return join(pawsPaths(home).secretsDir, "boat-token");
}

export function instaboxTokenPath(home: string): string {
  return join(pawsPaths(home).secretsDir, "instabox-token");
}

const TOKEN_PATHS = {
  "exe-dev": exeDevTokenPath,
  boat: boatTokenPath,
  instabox: instaboxTokenPath,
} as const;

export function readVmProviderToken(
  home: string,
  provider: MemberVmProviderName,
  migrate = true,
): string | null {
  const text = readSecretFile(TOKEN_PATHS[provider](home), migrate);
  if (text === null) return null;
  const token = text.trim();
  return token.length > 0 ? token : null;
}

export function vmProviderTokenStatus(
  home: string,
  provider: MemberVmProviderName,
): ExeDevTokenStatus {
  if (!secretFileExists(TOKEN_PATHS[provider](home))) return "absent";
  try {
    return readVmProviderToken(home, provider, false) === null ? "empty" : "readable";
  } catch (error) {
    journalCaught(error, "vm-provider-tokens.vmProviderTokenStatus", null);
    return "unreadable";
  }
}

export function memberVmKeyReadable(home: string, settings: VmSizes | undefined): boolean {
  return readVmProviderToken(home, memberVmProvider(settings)) !== null;
}
