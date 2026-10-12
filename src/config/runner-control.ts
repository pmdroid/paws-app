import { isIP } from "node:net";
import { join } from "node:path";
import type { EnvSource, PawsEnv } from "./env";

export function loadRunnerControl(source: EnvSource, env: PawsEnv) {
  const hostname = source.PAWS_RUNNER_HOST?.trim();
  if (!hostname) return null;
  if (
    !isIP(hostname) &&
    (hostname.length > 253 ||
      !hostname
        .split(".")
        .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))
  )
    throw new Error("PAWS_RUNNER_HOST must be a hostname or IP address.");
  const rawPort = source.PAWS_RUNNER_PORT ?? "8788";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PAWS_RUNNER_PORT must be an integer from 0 to 65535.");
  return { hostname, port, root: join(env.home, "secrets", "runner-identity") };
}
