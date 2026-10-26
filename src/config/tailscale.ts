import { journalCaught } from "../journal";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile } from "../credentials";
import { pawsPaths } from "./paths";

/** The Tailscale auth key a Create VM VM joins the Paws tailnet with. */
export const TAILSCALE_AUTHKEY_FILE = "tailscale-authkey";

export function tailscaleAuthKeyPath(home: string): string {
  return join(pawsPaths(home).secretsDir, TAILSCALE_AUTHKEY_FILE);
}

export function readTailscaleAuthKey(home: string, migrate = true): string | null {
  const text = readSecretFile(tailscaleAuthKeyPath(home), migrate);
  if (text === null) return null;
  const key = text.trim();
  return key.length > 0 ? key : null;
}

export type TailscaleAuthKeyStatus = "absent" | "empty" | "readable" | "unreadable";

export function tailscaleAuthKeyStatus(home: string): TailscaleAuthKeyStatus {
  if (!existsSync(tailscaleAuthKeyPath(home))) return "absent";
  try {
    return readTailscaleAuthKey(home, false) === null ? "empty" : "readable";
  } catch (caughtError1) {
    journalCaught(caughtError1, "tailscale.tailscaleAuthKeyStatus.readTailscaleAuthKey", null);
    return "unreadable";
  }
}

/** Whether `url` names a host inside a Tailscale tailnet (MagicDNS `*.ts.net`). */
export function isTailnetUrl(url: string | null): boolean {
  if (url === null) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith(".ts.net");
  } catch (caughtError2) {
    journalCaught(caughtError2, "tailscale.isTailnetUrl.toLowerCase", null);
    return false;
  }
}
