import { journal, journalCaught } from "../journal";
import { assertCommand, assertVmName, newVmCommand, shellQuote } from "./names";
import {
  ProvisioningError,
  type ExeDev,
  type ExeDevCreatedVm,
  type ExeDevVmSize,
  type ExeDevDeleteResult,
  type ExeDevExecOptions,
  type ExeDevExecResult,
  type ExeDevVm,
  type ProvisioningErrorCode,
  type ProvisioningOperation,
} from "./types";

export const EXE_DEV_ENDPOINT = "https://exe.dev/exec";

/** exe.dev ends an exec that runs longer than this with HTTP 504. */
export const EXE_DEV_EXEC_LIMIT_MS = 30_000;

export type ExeDevFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ExeDevTokenReader = () => string | null | Promise<string | null>;

export type ExeDevOptions = {
  readToken: ExeDevTokenReader;
  fetch?: ExeDevFetch;
  timeoutMs?: Partial<Record<ProvisioningOperation, number>>;
  maxResponseBytes?: Partial<Record<ProvisioningOperation, number>>;
};

export const DEFAULT_TIMEOUT_MS: Readonly<Record<ProvisioningOperation, number>> = {
  createVm: 120_000,
  deleteVm: 120_000,
  getVm: 15_000,
  // A little past exe.dev's own limit, so its 504 arrives before Paws gives up.
  execVm: EXE_DEV_EXEC_LIMIT_MS + 5_000,
};

export const DEFAULT_MAX_RESPONSE_BYTES: Readonly<Record<ProvisioningOperation, number>> = {
  createVm: 64 * 1024,
  deleteVm: 64 * 1024,
  getVm: 64 * 1024,
  execVm: 8 * 1024 * 1024,
};

const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const STATUS_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function createExeDev(options: ExeDevOptions): ExeDev {
  const fetcher: ExeDevFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = { ...DEFAULT_TIMEOUT_MS, ...options.timeoutMs };
  const maxBytes = { ...DEFAULT_MAX_RESPONSE_BYTES, ...options.maxResponseBytes };

  async function call(
    operation: ProvisioningOperation,
    vm: string,
    body: string,
    accept: string,
    timeoutMs: number,
  ): Promise<{ status: number; contentType: string | null; text: string }> {
    const token = await bearer(operation, options.readToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await abortable(
        fetcher(EXE_DEV_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: accept,
            "Content-Type": "text/plain; charset=utf-8",
            "User-Agent": "paws",
          },
          body,
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      const limit = maxBytes[operation];
      const text = await readCapped(response, limit, controller.signal);
      if (text === null) {
        if (!response.ok) throw httpError(operation, vm, response.status, null);
        throw new ProvisioningError(
          operation,
          "invalid_response",
          `exe.dev ${operation} for ${vm}: response is larger than ${limit} bytes.`,
          response.status,
        );
      }
      // For an exec, 422 means the command ran and exited non-zero; the stream still carries it.
      const ran = operation === "execVm" && response.status === 422;
      if (!response.ok && !ran) throw httpError(operation, vm, response.status, text);
      return { status: response.status, contentType: response.headers.get("content-type"), text };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      if (controller.signal.aborted) {
        throw new ProvisioningError(
          operation,
          "timeout",
          `exe.dev ${operation} for ${vm} did not finish within ${timeoutMs} ms.`,
        );
      }
      throw new ProvisioningError(
        operation,
        "unknown",
        `exe.dev ${operation} for ${vm}: the request failed before a response arrived.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function unlisted(vm: string): Promise<boolean> {
    try {
      const { status, text } = await call(
        "getVm",
        vm,
        `ls ${vm}`,
        "application/json",
        timeout.getVm,
      );
      parseListed(vm, status, text);
      return false;
    } catch (error) {
      journalCaught(error, "client.unlisted.call", null);
      return error instanceof ProvisioningError && error.code === "missing";
    }
  }

  return {
    async createVm(name, size) {
      const vm = assertVmName("createVm", name);
      const command = newVmCommand(vm, size);
      try {
        const { status, text } = await call(
          "createVm",
          vm,
          command,
          "application/json",
          timeout.createVm,
        );
        return parseCreated(vm, status, text);
      } catch (error) {
        if (!sizeRefusal(error, size)) throw error;
        const token = await Promise.resolve()
          .then(() => options.readToken())
          .catch((caughtError6) => {
            journalCaught(caughtError6, "client.createVm.readToken", null);
            return null;
          });
        throw sizeRefused(error, vm, command, token);
      }
    },

    async deleteVm(name) {
      const vm = assertVmName("deleteVm", name);
      try {
        const { status, text } = await call(
          "deleteVm",
          vm,
          `rm ${vm}`,
          "application/json",
          timeout.deleteVm,
        );
        return parseDeleted(vm, status, text);
      } catch (error) {
        if (error instanceof ProvisioningError && error.code === "missing") {
          journalCaught(error, "client.deleteVm.call", null);
          return "missing";
        }
        if (
          error instanceof ProvisioningError &&
          error.code === "invalid_response" &&
          (await unlisted(vm))
        ) {
          journalCaught(error, "client.deleteVm.call", null);
          return "missing";
        }
        throw error;
      }
    },

    async getVm(name) {
      const vm = assertVmName("getVm", name);
      const { status, text } = await call(
        "getVm",
        vm,
        `ls ${vm}`,
        "application/json",
        timeout.getVm,
      );
      return parseListed(vm, status, text);
    },

    async execVm(name, command, execOptions: ExeDevExecOptions = {}) {
      const vm = assertVmName("execVm", name);
      const line = assertCommand(command);
      const requested = execOptions.timeoutMs;
      const ms =
        requested !== undefined && Number.isFinite(requested) && requested > 0
          ? Math.min(requested, timeout.execVm)
          : timeout.execVm;
      const { status, contentType, text } = await call(
        "execVm",
        vm,
        `ssh ${vm} ${shellQuote(line)}`,
        "application/x-ndjson",
        ms,
      );
      return parseExec(vm, status, contentType, text);
    },
  };
}

async function bearer(operation: ProvisioningOperation, read: ExeDevTokenReader): Promise<string> {
  let token: string | null;
  try {
    token = await read();
  } catch (caughtError1) {
    journalCaught(caughtError1, "client.bearer.read", null);
    token = null;
  }
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed.length === 0 || !TOKEN.test(trimmed)) {
    throw new ProvisioningError(
      operation,
      "no_token",
      `exe.dev ${operation}: the exe.dev token in ~/.paws/secrets/exe-dev-token is missing or unreadable.`,
    );
  }
  return trimmed;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        journalCaught(error, "client.abortable", null);
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("request failed"));
      },
    );
  });
}

async function readCapped(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "client.readCapped.cancel", null);
    });
    return null;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const onAbort = () =>
    void reader.cancel().catch((caughtError3) => {
      journalCaught(caughtError3, "client.readCapped.cancel", null);
    });
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch((caughtError4) => {
          journalCaught(caughtError4, "client.readCapped.cancel", null);
        });
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

function httpError(
  operation: ProvisioningOperation,
  vm: string,
  status: number,
  text: string | null,
): ProvisioningError {
  if (status === 504) {
    const detail =
      operation === "execVm"
        ? `the command is still running on the VM or timed out there; exe.dev stops waiting after ${EXE_DEV_EXEC_LIMIT_MS / 1000} s`
        : "exe.dev stopped waiting for the request";
    return new ProvisioningError(
      operation,
      "timeout",
      `exe.dev ${operation} for ${vm} got HTTP 504: ${detail}.`,
      status,
    );
  }
  const detail = text === null ? null : errorText(text);
  const code = codeFor(status, detail);
  return new ProvisioningError(
    operation,
    code,
    `exe.dev ${operation} for ${vm} failed with HTTP ${status} (${code}).`,
    status,
    detail,
  );
}

const SIZE_FLAGS = /^--(?:cpu|memory|disk|image)=/;
const MAX_DETAIL = 300;

/**
 * A `new` with size flags that exe.dev refuses, for example over the plan's CPU limit, carries
 * exe.dev's own message so the Runners page can say which value to change. A bare `new` keeps
 * the message without exe.dev's text.
 */
function sizeRefusal(
  error: unknown,
  size: ExeDevVmSize | undefined,
): error is ProvisioningError & { detail: string } {
  return (
    error instanceof ProvisioningError &&
    error.detail !== null &&
    error.code === "unknown" &&
    size !== undefined &&
    Object.values(size).some((value) => value !== undefined)
  );
}

function sizeRefused(
  error: ProvisioningError & { detail: string },
  vm: string,
  command: string,
  token: string | null,
): ProvisioningError {
  const flags = command.split(" ").filter((flag) => SIZE_FLAGS.test(flag));
  const trimmed = token?.trim();
  const said = (trimmed ? error.detail.replaceAll(trimmed, "[redacted]") : error.detail)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const shown = said.length > MAX_DETAIL ? `${said.slice(0, MAX_DETAIL - 1)}…` : said;
  return new ProvisioningError(
    "createVm",
    error.code,
    `exe.dev refused Create VM for ${vm} with ${flags.join(" ")}: ${shown}${/[.!?]$/.test(shown) ? "" : "."} Change [member_vm] in config.toml.`,
    error.status,
    error.detail,
  );
}

function codeFor(status: number, error: string | null): ProvisioningErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 409) return "conflict";
  if (status === 404 || status === 410) return "missing";
  if (status === 429) return "rate_limited";
  if (error !== null) {
    const lower = error.toLowerCase();
    if (lower.includes("already exists")) return "conflict";
    if (lower.includes("not found") || lower.includes("no such vm")) return "missing";
    if (lower.includes("rate limit") || lower.includes("too many requests")) return "rate_limited";
  }
  return "unknown";
}

function errorText(text: string): string | null {
  const parsed = parseJson(text);
  if (isRecord(parsed) && typeof parsed["error"] === "string") return parsed["error"];
  return null;
}

function parseCreated(vm: string, status: number, text: string): ExeDevCreatedVm {
  const body = parseJson(text);
  commandFailure("createVm", vm, status, body);
  if (!isRecord(body) || body["vm_name"] !== vm) throw invalid("createVm", vm, status);
  const sshDest = body["ssh_dest"];
  const httpsUrl = body["https_url"];
  if (!isDest(sshDest) || !isHttpsUrl(httpsUrl)) throw invalid("createVm", vm, status);
  return { name: vm, sshDest, httpsUrl };
}

function parseDeleted(vm: string, status: number, text: string): ExeDevDeleteResult {
  if (text.trim().length === 0) return "deleted";
  const body = parseJson(text);
  if (body === undefined) throw invalid("deleteVm", vm, status);
  commandFailure("deleteVm", vm, status, body);
  return "deleted";
}

function parseListed(vm: string, status: number, text: string): ExeDevVm {
  const body = parseJson(text);
  commandFailure("getVm", vm, status, body);
  if (!isRecord(body) || !Array.isArray(body["vms"])) throw invalid("getVm", vm, status);
  const entries: unknown[] = body["vms"];
  if (!entries.every(isRecord)) throw invalid("getVm", vm, status);
  const matches = entries.filter((entry) => entry["vm_name"] === vm);
  if (matches.length === 0) {
    throw new ProvisioningError("getVm", "missing", `exe.dev getVm: ${vm} is not listed.`, status);
  }
  const entry = matches[0];
  if (matches.length > 1 || entry === undefined) throw invalid("getVm", vm, status);
  const state = entry["status"];
  const sshDest = entry["ssh_dest"];
  const httpsUrl = entry["https_url"];
  const region = entry["region"] ?? null;
  if (
    typeof state !== "string" ||
    !STATUS_WORD.test(state) ||
    !isDest(sshDest) ||
    !isHttpsUrl(httpsUrl) ||
    (region !== null && (typeof region !== "string" || !STATUS_WORD.test(region)))
  ) {
    throw invalid("getVm", vm, status);
  }
  return { name: vm, status: state, sshDest, httpsUrl, region };
}

function parseExec(
  vm: string,
  status: number,
  contentType: string | null,
  text: string,
): ExeDevExecResult {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let exitCode: number | null = null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const unexpected = (reason: string): ProvisioningError => {
    journal(execShape(vm, status, contentType, lines));
    return new ProvisioningError(
      "execVm",
      "invalid_response",
      `exe.dev execVm for ${vm}: ${reason}`,
      status,
    );
  };
  for (const [index, raw] of lines.entries()) {
    const at = `line ${index + 1} of ${lines.length}`;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (exitCode !== null) throw unexpected(`${at} follows the exit status.`);
    const record = parseJson(line);
    if (record === undefined) throw unexpected(`${at} is not JSON.`);
    if (!isRecord(record)) throw unexpected(`${at} is not a JSON object.`);
    const keys = Object.keys(record);
    if (keys.length !== 1)
      throw unexpected(`${at} has ${keys.length} keys (${keyList(keys)}) instead of one.`);
    const [key] = keys;
    const value = record[key ?? ""];
    if (key === "stdout" || key === "stderr") {
      if (typeof value !== "string" || !BASE64.test(value))
        throw unexpected(`${at} has ${key} that is not base64.`);
      (key === "stdout" ? stdout : stderr).push(Buffer.from(value, "base64"));
    } else if (key === "exit_code") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)
        throw unexpected(`${at} has an exit_code that is not 0 to 255.`);
      exitCode = value;
    } else if (key === "error") {
      if (typeof value !== "string" || index !== lines.length - 1)
        throw unexpected(`${at} is an error before the end of the stream.`);
      throw new ProvisioningError(
        "execVm",
        codeFor(status, value),
        `exe.dev execVm on ${vm} ended without an exit status.`,
        status,
      );
    } else {
      throw unexpected(`${at} has the unknown key ${keyList(keys)}.`);
    }
  }
  if (exitCode === null) {
    throw unexpected(
      lines.length === 0
        ? "the response was empty, with no exit status."
        : `the response was cut off before the exit status, after ${lines.length} lines.`,
    );
  }
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

const KEY = /^[A-Za-z0-9_]{1,32}$/;
/** Runs long enough to be a token, key or base64 output, in a line that is not JSON. */
const TOKEN_LIKE = /[A-Za-z0-9+/=_.~-]{16,}/g;
const SHAPE_LINES = 20;

function keyList(keys: readonly string[]): string {
  return keys.map((key) => (KEY.test(key) ? key : "?")).join(", ");
}

/**
 * One journal line on what an unexpected exec response looked like: its status, content type,
 * line count and each line's keys. A line that is not JSON shows its length and its first 80
 * characters without anything token-like. No stdout, stderr or error text is ever included.
 */
function execShape(
  vm: string,
  status: number,
  contentType: string | null,
  lines: readonly string[],
): string {
  const shapes = lines.slice(0, SHAPE_LINES).map((raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const head = line
        .slice(0, 80)
        .replace(TOKEN_LIKE, "[redacted]")
        .replace(/[^\x20-\x7e]/g, "?")
        .replaceAll('"', "'");
      return `[text length=${line.length} head="${head}"]`;
    }
    if (isRecord(parsed)) return `[${keyList(Object.keys(parsed))}]`;
    return `[${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}]`;
  });
  if (lines.length > SHAPE_LINES) shapes.push(`[${lines.length - SHAPE_LINES} more]`);
  const type = (contentType ?? "none").slice(0, 80).replace(/[^\w.+/=;-]/g, "?");
  return `exe.dev execVm unexpected response vm=${vm} status=${status} content_type=${type} lines=${lines.length} shape=${shapes.join(" ") || "[]"}`;
}

function commandFailure(
  operation: ProvisioningOperation,
  vm: string,
  status: number,
  body: unknown,
): void {
  if (!isRecord(body) || !("error" in body)) return;
  const error = body["error"];
  if (typeof error !== "string") throw invalid(operation, vm, status);
  const code = codeFor(status, error);
  throw new ProvisioningError(
    operation,
    code,
    `exe.dev ${operation} for ${vm} was refused (${code}).`,
    status,
    error,
  );
}

function invalid(operation: ProvisioningOperation, vm: string, status: number): ProvisioningError {
  return new ProvisioningError(
    operation,
    "invalid_response",
    `exe.dev ${operation} for ${vm}: the response did not have the expected shape.`,
    status,
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (caughtError5) {
    journalCaught(caughtError5, "client.parseJson.parse", null);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._+@-]{1,255}$/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch (caughtError6) {
    journalCaught(caughtError6, "client.isHttpsUrl", null);
    return false;
  }
}
