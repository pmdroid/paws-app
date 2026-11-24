import { checkMemberVmSize } from "../config";
import { journalCaught } from "../journal";
import { abortable, readCapped, type ExeDevFetch, type ExeDevTokenReader } from "./client";
import { isExeDevVmName, MAX_EXEC_COMMAND_BYTES } from "./names";
import {
  ProvisioningError,
  type ProvisioningErrorCode,
  type ProvisioningOperation,
  type VmProvider,
  type VmState,
} from "./types";

export const INSTABOX_ENDPOINT = "https://api.instabox.sh";
export const INSTABOX_TEMPLATE = "agent-browser";
const INSTABOX_EXEC_LIMIT_SECONDS = 600;

export type InstaBoxLookup = (name: string) => string | null | Promise<string | null>;

export type InstaBoxOptions = {
  readToken: ExeDevTokenReader;
  lookup: InstaBoxLookup;
  fetch?: ExeDevFetch;
  timeoutMs?: Partial<Record<"createVm" | "deleteVm" | "getVm", number>>;
};

type Operation = Extract<ProvisioningOperation, "createVm" | "deleteVm" | "execVm" | "getVm">;

const TIMEOUT_MS: Readonly<Record<Exclude<Operation, "execVm">, number>> = {
  createVm: 60_000,
  deleteVm: 60_000,
  getVm: 15_000,
};
const EXEC_MARGIN_MS = 15_000;
const DEFAULT_EXEC_SECONDS = 60;
const MAX_BYTES: Readonly<Record<Operation, number>> = {
  createVm: 64 * 1024,
  deleteVm: 64 * 1024,
  getVm: 256 * 1024,
  execVm: 8 * 1024 * 1024,
};
const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const MACHINE_ID = /^m_[A-Za-z0-9]{26}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const STATE_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_DETAIL = 300;

const STATES: Readonly<Record<string, VmState>> = {
  running: "running",
  creating: "starting",
  starting: "starting",
  resuming: "starting",
  stopping: "stopping",
  suspending: "stopping",
  stopped: "stopped",
  suspended: "stopped",
  error: "error",
};

function instaBoxVmState(state: string): VmState {
  return Object.hasOwn(STATES, state) ? (STATES[state] ?? "unknown") : "unknown";
}

type Request = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
};

export function createInstaBox(options: InstaBoxOptions): VmProvider {
  const fetcher: ExeDevFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = { ...TIMEOUT_MS, ...options.timeoutMs };

  async function call(
    operation: Operation,
    vm: string,
    request: Request,
  ): Promise<{ status: number; body: unknown }> {
    const token = await bearer(operation, options.readToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await abortable(
        fetcher(`${INSTABOX_ENDPOINT}${request.path}`, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": "paws",
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      const limit = MAX_BYTES[operation];
      const text = await readCapped(response, limit, controller.signal);
      if (text === null) {
        if (!response.ok) throw httpError(operation, vm, response.status, undefined, token);
        throw new ProvisioningError(
          operation,
          "invalid_response",
          `InstaBox ${operation} for ${vm}: response is larger than ${limit} bytes.`,
          response.status,
        );
      }
      const body = parseJson(text);
      if (!response.ok) throw httpError(operation, vm, response.status, body, token);
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      if (controller.signal.aborted)
        throw new ProvisioningError(
          operation,
          "timeout",
          `InstaBox ${operation} for ${vm} did not finish within ${request.timeoutMs} ms.`,
        );
      throw new ProvisioningError(
        operation,
        "unknown",
        `InstaBox ${operation} for ${vm}: the request failed before a response arrived.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function machineId(operation: Operation, name: string): Promise<string> {
    const vm = assertName(operation, name);
    const id = await options.lookup(vm);
    if (id === null)
      throw new ProvisioningError(
        operation,
        "missing",
        `InstaBox ${operation}: ${vm} has no InstaBox machine id.`,
      );
    if (!MACHINE_ID.test(id))
      throw new ProvisioningError(
        operation,
        "invalid_response",
        `InstaBox ${operation}: the machine id stored for ${vm} is not an InstaBox id.`,
      );
    return id;
  }

  return {
    id: "instabox",

    async createVm(name, size = {}, request) {
      const vm = assertName("createVm", name);
      try {
        checkMemberVmSize("instabox", { ...size });
      } catch (error) {
        throw new ProvisioningError("createVm", "unknown", (error as Error).message);
      }
      const key = request?.key ?? vm;
      const sized = size.cpu !== undefined && size.memoryGb !== undefined;
      const { status, body } = await call("createVm", vm, {
        method: "POST",
        path: "/v1/machines",
        headers: { "Idempotency-Key": key },
        body: {
          name: vm,
          templateId: INSTABOX_TEMPLATE,
          autoSuspendAfterSeconds: 0,
          maxRunMinutes: -1,
          ...(sized ? { vcpus: size.cpu, memMiB: (size.memoryGb ?? 0) * 1024 } : {}),
          ...(size.diskGb === undefined ? {} : { persistentDiskGiB: size.diskGb }),
        },
        timeoutMs: timeout.createVm,
      });
      const id = isRecord(body) ? body["machineId"] : undefined;
      if (typeof id !== "string" || !MACHINE_ID.test(id)) throw invalid("createVm", vm, status);
      return { name: vm, id, sshDest: id, httpsUrl: machineUrl(id) };
    },

    async getVm(name) {
      const id = await machineId("getVm", name);
      const { status, body } = await call("getVm", name, {
        method: "GET",
        path: `/v1/machines/${id}`,
        timeoutMs: timeout.getVm,
      });
      const state = isRecord(body) ? body["state"] : undefined;
      if (
        !isRecord(body) ||
        body["id"] !== id ||
        typeof state !== "string" ||
        !STATE_WORD.test(state)
      )
        throw invalid("getVm", name, status);
      return {
        name,
        status: state,
        state: instaBoxVmState(state),
        sshDest: id,
        httpsUrl: machineUrl(id),
        region: null,
      };
    },

    async execVm(name, command, execOptions = {}) {
      const id = await machineId("execVm", name);
      const cmd = assertCommand(command);
      const seconds = execSeconds(execOptions.timeoutMs);
      const { status, body } = await call("execVm", name, {
        method: "POST",
        path: `/v1/machines/${id}/exec`,
        body: { cmd, timeoutSeconds: seconds },
        timeoutMs: seconds * 1000 + EXEC_MARGIN_MS,
      });
      if (!isRecord(body)) throw invalid("execVm", name, status);
      if (body["timedOut"] === true)
        throw new ProvisioningError(
          "execVm",
          "timeout",
          `InstaBox execVm on ${name}: the command did not finish within ${seconds} s.`,
          status,
        );
      const { exitCode, stdout, stderr } = body;
      if (
        typeof exitCode !== "number" ||
        !Number.isInteger(exitCode) ||
        exitCode < 0 ||
        exitCode > 255 ||
        typeof stdout !== "string" ||
        typeof stderr !== "string"
      )
        throw invalid("execVm", name, status);
      return { exitCode, stdout, stderr };
    },

    async deleteVm(name) {
      let id: string;
      try {
        id = await machineId("deleteVm", name);
      } catch (error) {
        if (!(error instanceof ProvisioningError) || error.code !== "missing") throw error;
        journalCaught(error, "instabox.deleteVm.lookup", null);
        return "missing";
      }
      try {
        await call("deleteVm", name, {
          method: "DELETE",
          path: `/v1/machines/${id}`,
          headers: { "X-Confirm-Delete": id, "Idempotency-Key": `paws-delete-${id}` },
          timeoutMs: timeout.deleteVm,
        });
        return "deleted";
      } catch (error) {
        if (!(error instanceof ProvisioningError) || error.code !== "missing") throw error;
        journalCaught(error, "instabox.deleteVm.call", null);
        return "missing";
      }
    },
  };
}

function machineUrl(id: string): string {
  return `${INSTABOX_ENDPOINT}/v1/machines/${id}`;
}

function execSeconds(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return DEFAULT_EXEC_SECONDS;
  return Math.min(INSTABOX_EXEC_LIMIT_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1000)));
}

function assertName(operation: Operation, name: unknown): string {
  if (isExeDevVmName(name)) return name;
  throw new ProvisioningError(
    operation,
    "invalid_name",
    `InstaBox ${operation}: VM name must be 1 to 63 lowercase letters, digits or inner hyphens.`,
  );
}

function assertCommand(command: unknown): string {
  if (
    typeof command === "string" &&
    command.trim().length > 0 &&
    !command.includes("\0") &&
    Buffer.byteLength(command) <= MAX_EXEC_COMMAND_BYTES
  )
    return command;
  throw new ProvisioningError(
    "execVm",
    "invalid_command",
    `InstaBox execVm: command must be non-empty, at most ${MAX_EXEC_COMMAND_BYTES} bytes, and free of NUL bytes.`,
  );
}

async function bearer(operation: Operation, read: ExeDevTokenReader): Promise<string> {
  let token: string | null;
  try {
    token = await read();
  } catch (error) {
    journalCaught(error, "instabox.bearer.read", null);
    token = null;
  }
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed.length > 0 && TOKEN.test(trimmed)) return trimmed;
  throw new ProvisioningError(
    operation,
    "no_token",
    `InstaBox ${operation}: the InstaBox key is missing or unreadable. Save it on Settings › Runner VMs.`,
  );
}

function codeFor(status: number): ProvisioningErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "missing";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "unknown";
}

function httpError(
  operation: Operation,
  vm: string,
  status: number,
  body: unknown,
  token: string,
): ProvisioningError {
  const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
  const raw = error?.["code"];
  const code = typeof raw === "string" && CODE.test(raw) ? raw : null;
  const text = typeof error?.["message"] === "string" ? error["message"] : null;
  const ours = codeFor(status);
  const said = code === null ? "" : `: ${code}`;
  const detail = code === null && text === null ? null : clean([code, text], token);
  return new ProvisioningError(
    operation,
    ours,
    `InstaBox ${operation} for ${vm} failed with HTTP ${status} (${ours})${said}.`,
    status,
    detail,
  );
}

function clean(parts: readonly (string | null)[], token: string): string {
  const joined = parts
    .filter((part) => part !== null)
    .join(": ")
    .replaceAll(token, "[redacted]");
  const line = Array.from(joined, (char) => {
    const point = char.codePointAt(0) ?? 0;
    return point < 0x20 || point === 0x7f ? " " : char;
  })
    .join("")
    .trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

function invalid(operation: Operation, vm: string, status: number): ProvisioningError {
  return new ProvisioningError(
    operation,
    "invalid_response",
    `InstaBox ${operation} for ${vm}: the response did not have the expected shape.`,
    status,
  );
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    journalCaught(error, "instabox.parseJson", null);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
