import { isIP } from "node:net";
import { join } from "node:path";
import type { EnvSource, PawsEnv } from "./env";

export function loadRunnerControl(source: EnvSource, env: PawsEnv) {
  const hostname = source.PAWS_RUNNER_HOST?.trim();
  const rawUrl = source.PAWS_RUNNER_URL?.trim();
  const keyPath = source.PAWS_RUNNER_TLS_KEY_PATH?.trim();
  const certPath = source.PAWS_RUNNER_TLS_CERT_PATH?.trim();
  if (!hostname) {
    if (rawUrl || keyPath || certPath)
      throw new Error(
        "PAWS_RUNNER_URL, PAWS_RUNNER_TLS_KEY_PATH and PAWS_RUNNER_TLS_CERT_PATH require PAWS_RUNNER_HOST.",
      );
    return null;
  }
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
  return {
    hostname,
    port,
    url: rawUrl ? runnerOrigin(rawUrl) : null,
    tls: keyPath || certPath ? { keyPath: keyPath ?? "", certPath: certPath ?? "" } : null,
    root: join(env.home, "secrets", "runner-identity"),
  };
}

function runnerOrigin(value: string): string {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("PAWS_RUNNER_URL must be an HTTPS origin.");
  return url.origin;
}
