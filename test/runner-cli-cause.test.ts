import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CAUSE_LIMIT,
  describeRunnerFailure,
  loadConfig,
  readTokenFile,
  RUNNER_FAILURE,
  RunnerCliFailure,
  runnerFailureLine,
  journalRunnerFailure,
} from "../src/runner-cli";
import { RunnerRequestError, RunnerTransportError, transportFailure } from "../src/runner-daemon";

const TOKEN = "Q2xvc2VvdXRUb2tlbl9mb3JfdGVzdHNfMDEyMzQ1Njc4OQ";
const CONTROL = new URL("https://paws.example.com/api/runner-enrollments");
const RUNNER_API = new URL("https://runners.example.com:8788/api/runner/heartbeat");

/** A Node-style system error as Bun's `node:https` reports it, carrying the token in its text. */
function systemError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${code} while sending token=${TOKEN}`), { code, ...extra });
}

function transport(url: URL, code: string, extra: Record<string, unknown> = {}) {
  return transportFailure(systemError(code, extra), url, "POST", url.pathname, 12);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempFile(content: string, mode = 0o600): string {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-cause-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function configFailure(path: string): string {
  try {
    loadConfig(path, process.getuid!());
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerCliFailure);
    expect((error as RunnerCliFailure).kind).toBe("config");
    return runnerFailureLine(error, [TOKEN]);
  }
  throw new Error("configuration loaded");
}

describe("runner failure causes", () => {
  test("a DNS failure names the host that did not resolve", () => {
    for (const [url, host] of [
      [CONTROL, "paws.example.com"],
      [RUNNER_API, "runners.example.com"],
    ] as const) {
      const error = transport(url, "ENOTFOUND", { hostname: host });
      expect(describeRunnerFailure(error)).toBe(`DNS lookup failed for ${host} (ENOTFOUND).`);
    }
    expect(describeRunnerFailure(transport(CONTROL, "EAI_AGAIN"))).toBe(
      "DNS lookup failed for paws.example.com (EAI_AGAIN).",
    );
  });

  test("a refused, timed out or unreachable connection names host and port", () => {
    expect(describeRunnerFailure(transport(CONTROL, "ECONNREFUSED"))).toBe(
      "Connection refused by paws.example.com:443.",
    );
    expect(describeRunnerFailure(transport(RUNNER_API, "ECONNREFUSED"))).toBe(
      "Connection refused by runners.example.com:8788.",
    );
    const timedOut = transportFailure(
      new Error("Runner request timed out."),
      RUNNER_API,
      "POST",
      RUNNER_API.pathname,
      30_000,
      true,
    );
    expect(describeRunnerFailure(timedOut)).toBe(
      "Connection to runners.example.com:8788 timed out.",
    );
    expect(describeRunnerFailure(transport(CONTROL, "ETIMEDOUT"))).toBe(
      "Connection to paws.example.com:443 timed out.",
    );
    expect(describeRunnerFailure(transport(CONTROL, "EHOSTUNREACH"))).toBe(
      "Could not reach paws.example.com:443 (EHOSTUNREACH).",
    );
  });

  test("a TLS or certificate failure names the code and endpoint", () => {
    for (const code of [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
    ])
      expect(describeRunnerFailure(transport(RUNNER_API, code))).toBe(
        `TLS or certificate verification failed for runners.example.com:8788 (${code}).`,
      );
  });

  test("an unknown transport failure names only the endpoint and a well-formed code", () => {
    expect(describeRunnerFailure(transport(CONTROL, `bad code ${TOKEN}`))).toBe(
      "Request to paws.example.com:443 failed (no error code).",
    );
  });

  test("an HTTP status from the enrollment endpoint is named", () => {
    expect(
      describeRunnerFailure(new RunnerRequestError(503, "POST", "/api/runner-enrollments", 9)),
    ).toBe("Paws answered HTTP 503 from /api/runner-enrollments.");
    expect(
      describeRunnerFailure(new RunnerRequestError(404, "POST", "/api/runner-enrollments", 9)),
    ).toBe(
      "Paws does not accept runner enrollments at this URL (HTTP 404 from /api/runner-enrollments).",
    );
    expect(describeRunnerFailure(new RunnerRequestError(429))).toBe("Paws answered HTTP 429.");
  });

  test("an invalid, expired or used token says so", () => {
    expect(
      describeRunnerFailure(new RunnerRequestError(401, "POST", "/api/runner-enrollments", 9)),
    ).toBe(
      "The enrollment token is invalid, expired or already used (HTTP 401 from /api/runner-enrollments).",
    );
    const missing = join(tmpdir(), `paws-missing-token-${process.pid}`);
    expect(readTokenFile(missing)).toBeNull();
    const notRoot = tempFile(`${TOKEN}\n`);
    let thrown: unknown;
    try {
      readTokenFile(notRoot);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunnerCliFailure);
    expect(describeRunnerFailure(thrown)).toBe(
      "Enrollment token must be a root-owned mode 0600 file.",
    );
  });

  test("an invalid configuration names the problem, not the contents", () => {
    const secret = `"serverCa": "${TOKEN}"`;
    const cases: [string, string][] = [
      [tempFile(`{ ${secret}, oops }`), "Runner configuration is not valid JSON."],
      [
        tempFile(JSON.stringify({ controlPlaneUrl: 1, runnerApiUrl: "x", [TOKEN]: TOKEN })),
        "Runner configuration has invalid fields: controlPlaneUrl, allowedRepositories, an unknown key.",
      ],
      [
        tempFile("{}", 0o644),
        "Runner configuration must be a protected regular file owned by root or the runner, mode 0600 or 0640.",
      ],
      [join(tmpdir(), `paws-missing-config-${process.pid}`), "Runner configuration is missing."],
      ["relative/config.json", "Runner configuration must use an absolute path."],
    ];
    for (const [path, cause] of cases) {
      const line = configFailure(path);
      expect(line).toBe(`${RUNNER_FAILURE} Cause: ${cause}`);
      expect(line).not.toContain(TOKEN);
    }
  });

  test("the token value never appears in any cause", () => {
    const failures: unknown[] = [
      transport(CONTROL, "ENOTFOUND", { hostname: "paws.example.com" }),
      transport(CONTROL, "ECONNREFUSED"),
      transport(CONTROL, "CERT_HAS_EXPIRED"),
      transport(CONTROL, `ENOPE ${TOKEN}`),
      new RunnerRequestError(401, "POST", `/api/runner-enrollments?token=${TOKEN}`, 3),
      new Error(`Enrollment failed for token ${TOKEN}`),
      new Error(TOKEN),
      new RunnerCliFailure("token", `Leaked ${TOKEN}`),
      z.strictObject({ token: z.literal("x") }).safeParse({ token: TOKEN, [TOKEN]: 1 }).error,
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${TOKEN}`), { name: TOKEN }),
      TOKEN,
    ];
    for (const failure of failures) {
      const line = runnerFailureLine(failure, [TOKEN]);
      expect(line.startsWith(`${RUNNER_FAILURE} Cause: `)).toBe(true);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(TOKEN.slice(0, 16));
    }
    // A token that looks like a plain sentence is still caught by the secret check.
    const lettersOnly = "Abcdefghijklmnopqrstuvwxyz";
    expect(describeRunnerFailure(new Error(lettersOnly), [lettersOnly])).toBe("Error.");
  });

  test("a fixed sentence passes through and data-bearing messages reduce to their class", () => {
    expect(describeRunnerFailure(new Error("Runner is already paired."))).toBe(
      "Runner is already paired.",
    );
    expect(describeRunnerFailure(new Error("Runner input at /var/lib/x is invalid"))).toBe(
      "Error.",
    );
    expect(describeRunnerFailure(new TypeError("Cannot read properties of undefined"))).toBe(
      "TypeError.",
    );
  });

  test("the cause is capped at 300 characters", () => {
    const long = new RunnerCliFailure("config", "A".repeat(1_000));
    expect(describeRunnerFailure(long)).toHaveLength(CAUSE_LIMIT);
    expect(CAUSE_LIMIT).toBe(300);
    expect(runnerFailureLine(long)).toBe(`${RUNNER_FAILURE} Cause: ${"A".repeat(300)}`);
  });

  test("transport failures keep the cause and endpoint for callers", () => {
    const error = transport(RUNNER_API, "ECONNREFUSED");
    expect(error).toBeInstanceOf(RunnerTransportError);
    expect(error.host).toBe("runners.example.com:8788");
    expect(error.code).toBe("ECONNREFUSED");
    expect((error.cause as Error).message).toContain("ECONNREFUSED");
  });
});

test("runner journal applies the file-token redactor before its only write", () => {
  const token = "FileOnlyEnrollmentSecret";
  const lines: string[] = [];
  journalRunnerFailure(new RunnerCliFailure("token", `Leaked ${token}`), [token], (line) =>
    lines.push(line),
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("operation=runner-cli.runRunnerCli");
  expect(lines[0]).toContain(RUNNER_FAILURE);
  expect(lines[0]).not.toContain(token);
});
