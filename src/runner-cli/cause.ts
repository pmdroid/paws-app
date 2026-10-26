import { ZodError } from "zod";
import { RunnerRequestError, RunnerTransportError } from "../runner-daemon";

/** The sentence every failed `enroll` or `daemon` command starts with. */
export const RUNNER_FAILURE =
  "Runner command failed. Check the service identity, configuration and enrollment.";

/** The longest cause printed after {@link RUNNER_FAILURE}. */
export const CAUSE_LIMIT = 300;

/**
 * A failure the CLI itself detected, with a fixed, secret-free message: a bad configuration file,
 * a missing or malformed token file, a wrong service identity, or a malformed command.
 */
export class RunnerCliFailure extends Error {
  constructor(
    readonly kind: "config" | "token" | "identity" | "usage",
    message: string,
  ) {
    super(message);
    this.name = "RunnerCliFailure";
  }
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);
const UNREACHABLE_CODES = new Set([
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EPIPE",
  "ECONNABORTED",
]);
const TLS_CODE =
  /^(ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ERR_OSSL_)|_CERT/;
const CONFIG_KEYS = new Set([
  "controlPlaneUrl",
  "runnerApiUrl",
  "allowedRepositories",
  "serverCa",
  "concurrency",
]);
/**
 * A fixed English sentence: letters, spaces and light punctuation only. Messages that carry data
 * (paths, URLs, numbers, quoted values, tokens with digits or `_`) do not match and are reduced to
 * their error class.
 */
const PLAIN_SENTENCE = /^[A-Z][A-Za-z ,.'()-]{0,199}$/;

function hostName(host: string): string {
  return host.slice(0, host.lastIndexOf(":"));
}

function transportCause(error: RunnerTransportError): string {
  const code = error.code;
  if (code && DNS_CODES.has(code))
    return `DNS lookup failed for ${hostName(error.host)} (${code}).`;
  if (code === "ECONNREFUSED") return `Connection refused by ${error.host}.`;
  if (code === "ETIMEDOUT") return `Connection to ${error.host} timed out.`;
  if (code && UNREACHABLE_CODES.has(code)) return `Could not reach ${error.host} (${code}).`;
  if (code && TLS_CODE.test(code))
    return `TLS or certificate verification failed for ${error.host} (${code}).`;
  return `Request to ${error.host} failed (${code ?? "no error code"}).`;
}

function requestCause(error: RunnerRequestError): string {
  const path =
    error.path !== undefined && /^\/[A-Za-z0-9/_.-]{0,200}$/.test(error.path)
      ? ` from ${error.path}`
      : "";
  if (error.path === "/api/runner-enrollments" && error.status === 401)
    return `The enrollment token is invalid, expired or already used (HTTP 401${path}).`;
  if (error.path === "/api/runner-enrollments" && error.status === 404)
    return `Paws does not accept runner enrollments at this URL (HTTP 404${path}).`;
  return `Paws answered HTTP ${error.status}${path}.`;
}

function zodCause(error: ZodError): string {
  const fields = [
    ...new Set(
      error.issues
        .map((issue) => issue.path[0])
        .filter((key): key is string => typeof key === "string" && CONFIG_KEYS.has(key)),
    ),
  ];
  return fields.length > 0
    ? `Validation failed for ${fields.join(", ")} (ZodError).`
    : "Validation failed (ZodError).";
}

/** The error's class name when it looks like one (`TypeError`, `DNSException`), else `Error`. */
function errorClass(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Za-z]{0,40}(Error|Exception)$/.test(error.name)
    ? error.name
    : "Error";
}

/**
 * A short cause for a runner command failure. It names an error class, a host or `host:port`, an
 * HTTP status, or a fixed sentence the runner wrote, and never a response body, file contents,
 * token or other secret. Any `secrets` value found in the result reduces it to the error class.
 */
export function describeRunnerFailure(error: unknown, secrets: readonly string[] = []): string {
  let cause: string;
  if (error instanceof RunnerCliFailure) cause = error.message;
  else if (error instanceof RunnerTransportError) cause = transportCause(error);
  else if (error instanceof RunnerRequestError) cause = requestCause(error);
  else if (error instanceof ZodError) cause = zodCause(error);
  else if (error instanceof Error && error.name === "Error" && PLAIN_SENTENCE.test(error.message))
    cause = error.message;
  else cause = `${errorClass(error)}.`;
  if (secrets.some((secret) => secret.length > 0 && cause.includes(secret))) cause = "Error.";
  return cause.slice(0, CAUSE_LIMIT);
}

/** The single stderr line a failed command prints, so callers that keep the tail still see it. */
export function runnerFailureLine(error: unknown, secrets: readonly string[] = []): string {
  return `${RUNNER_FAILURE} Cause: ${describeRunnerFailure(error, secrets)}`;
}
