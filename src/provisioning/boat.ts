import { checkMemberVmSize } from "../config";
import { journalCaught } from "../journal";
import { abortable, readCapped, type ExeDevFetch, type ExeDevTokenReader } from "./client";
import { assertCommand, assertVmName } from "./names";
import {
  ProvisioningError,
  type ExeDevVmSize,
  type ProvisioningErrorCode,
  type ProvisioningOperation,
  type VmProvider,
  type VmState,
} from "./types";

export const BOAT_ENDPOINT = "https://boat.dev/api/v1";

export type BoatOptions = {
  readToken: ExeDevTokenReader;
  lookup: (name: string) => string | null | Promise<string | null>;
  fetch?: ExeDevFetch;
  timeoutMs?: Partial<Record<BoatOperation, number>>;
};

type BoatOperation = Extract<
  ProvisioningOperation,
  "createVm" | "deleteVm" | "execVm" | "getVm" | "listVms"
>;

export type BoatSandbox = { id: string; state: VmState };

export type Boat = VmProvider & { listVms(): Promise<BoatSandbox[]> };

const TIMEOUT_MS: Readonly<Record<BoatOperation, number>> = {
  createVm: 120_000,
  deleteVm: 60_000,
  getVm: 15_000,
  execVm: 75_000,
  listVms: 10_000,
};

const SIZES = [
  [2, 4, "small"],
  [4, 8, "default"],
  [8, 16, "large"],
  [16, 32, "xlarge"],
] as const;

const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;
const SANDBOX_ID = /^bx_[A-Za-z0-9]{1,64}$/;
const STATE_WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_DETAIL = 300;
const AUTO_STOP_REFUSED =
  "boat's plan does not allow turning auto-stop off; a runner VM needs that.";

function boatVmState(state: string): VmState {
  if (["ready", "idle", "running"].includes(state)) return "running";
  if (["init", "provisioning", "provisioned", "cloning"].includes(state)) return "starting";
  if (state === "archiving") return "stopping";
  if (state === "archived") return "stopped";
  return state === "error" || state === "cancelled" ? "error" : "unknown";
}

function boatSandboxType(size: ExeDevVmSize | undefined): string {
  const cpu = size?.cpu;
  const memoryGb = size?.memoryGb;
  if (cpu === undefined && memoryGb === undefined) return "default";
  const match = SIZES.find(([c, m]) => c === cpu && m === memoryGb);
  if (match !== undefined) return match[2];
  try {
    checkMemberVmSize("boat", { ...size });
  } catch (error) {
    throw new ProvisioningError("createVm", "unknown", (error as Error).message);
  }
  throw new ProvisioningError("createVm", "unknown", "boat has no such size.");
}

export function createBoat(options: BoatOptions): Boat {
  const fetcher: ExeDevFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = { ...TIMEOUT_MS, ...options.timeoutMs };

  async function call(
    operation: BoatOperation,
    vm: string,
    request: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const token = await bearer(operation, options.readToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await abortable(
        fetcher(`${BOAT_ENDPOINT}${request.path}`, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
            "User-Agent": "paws",
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      const limit = operation === "execVm" ? 16 * 1024 * 1024 : 64 * 1024;
      const text = await readCapped(response, limit, controller.signal);
      if (text === null)
        throw new ProvisioningError(
          operation,
          response.ok ? "invalid_response" : codeFor(response.status),
          `boat ${operation} for ${vm}: response is larger than ${limit} bytes.`,
          response.status,
        );
      const body = parseJson(text);
      if (!response.ok) throw httpError(operation, vm, response.status, body, token);
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      if (controller.signal.aborted)
        throw new ProvisioningError(
          operation,
          "timeout",
          `boat ${operation} for ${vm} did not finish within ${timeoutMs} ms.`,
        );
      throw new ProvisioningError(
        operation,
        "unknown",
        `boat ${operation} for ${vm}: the request failed before a response arrived.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function sandbox(operation: BoatOperation, vm: string): Promise<string> {
    let id: string | null;
    try {
      id = await options.lookup(vm);
    } catch (error) {
      journalCaught(error, "boat.lookup", null);
      throw new ProvisioningError(
        operation,
        "unknown",
        `boat ${operation} for ${vm}: Paws could not read the VM's boat id.`,
      );
    }
    if (id === null)
      throw new ProvisioningError(
        operation,
        "missing",
        `boat ${operation} for ${vm}: Paws holds no boat id for it.`,
      );
    if (!SANDBOX_ID.test(id))
      throw new ProvisioningError(
        operation,
        "invalid_name",
        `boat ${operation} for ${vm}: the stored boat id is not a sandbox id.`,
      );
    return id;
  }

  return {
    id: "boat",

    async createVm(name, size, request) {
      const vm = assertVmName("createVm", name);
      const type = boatSandboxType(size);
      try {
        const { status, body } = await call(
          "createVm",
          vm,
          {
            method: "POST",
            path: "/sandboxes",
            body: { name: vm, type, ttlSeconds: null, labels: { paws: "runner" } },
            ...(request === undefined ? {} : { headers: { "Idempotency-Key": request.key } }),
          },
          timeout.createVm,
        );
        const created = record(record(body)?.["sandbox"]);
        const id = created?.["id"];
        if (typeof id !== "string" || !SANDBOX_ID.test(id)) throw invalid("createVm", vm, status);
        return { name: vm, id };
      } catch (error) {
        if (!(error instanceof ProvisioningError) || !error.detail?.startsWith(AUTO_STOP_CODE))
          throw error;
        throw new ProvisioningError(
          "createVm",
          error.code,
          AUTO_STOP_REFUSED,
          error.status,
          error.detail,
        );
      }
    },

    async getVm(name) {
      const vm = assertVmName("getVm", name);
      const id = await sandbox("getVm", vm);
      const { status, body } = await call(
        "getVm",
        vm,
        { method: "GET", path: `/sandboxes/${id}` },
        timeout.getVm,
      );
      const state = record(record(body)?.["sandbox"])?.["state"];
      if (typeof state !== "string" || !STATE_WORD.test(state)) throw invalid("getVm", vm, status);
      return { name: vm, status: state, state: boatVmState(state) };
    },

    async execVm(name, command, execOptions = {}) {
      const vm = assertVmName("execVm", name);
      const line = assertCommand(command);
      const id = await sandbox("execVm", vm);
      const requested = execOptions.timeoutMs;
      const seconds =
        requested !== undefined && Number.isFinite(requested) && requested > 0
          ? Math.min(600, Math.max(1, Math.ceil(requested / 1000)))
          : 30;
      const { status, body } = await call(
        "execVm",
        vm,
        {
          method: "POST",
          path: `/sandboxes/${id}/commands`,
          body: { command: line, timeoutSeconds: seconds },
        },
        seconds * 1000 + timeout.execVm,
      );
      const result = record(body);
      if (result?.["timedOut"] === true)
        throw new ProvisioningError(
          "execVm",
          "timeout",
          `boat execVm on ${vm}: the command did not finish within ${seconds} s.`,
          status,
        );
      const exitCode = result?.["exitCode"];
      const stdout = result?.["stdout"];
      const stderr = result?.["stderr"];
      if (typeof stdout !== "string" || typeof stderr !== "string")
        throw invalid("execVm", vm, status);
      if (exitCode === null)
        throw new ProvisioningError(
          "execVm",
          "unknown",
          `boat execVm on ${vm} ended without an exit status.`,
          status,
        );
      if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0)
        throw invalid("execVm", vm, status);
      return { exitCode, stdout, stderr };
    },

    async listVms() {
      const { status, body } = await call(
        "listVms",
        "sandboxes",
        { method: "GET", path: "/sandboxes?limit=200" },
        timeout.listVms,
      );
      const list = record(body)?.["sandboxes"];
      if (!Array.isArray(list)) throw invalid("listVms", "sandboxes", status);
      return list.map((entry: unknown) => {
        const id = record(entry)?.["id"];
        const state = record(entry)?.["state"];
        if (typeof id !== "string" || typeof state !== "string" || !STATE_WORD.test(state))
          throw invalid("listVms", "sandboxes", status);
        return { id, state: boatVmState(state) };
      });
    },

    async deleteVm(name) {
      const vm = assertVmName("deleteVm", name);
      let id: string;
      try {
        id = await sandbox("deleteVm", vm);
        await call(
          "deleteVm",
          vm,
          { method: "DELETE", path: `/sandboxes/${id}`, headers: { "X-Ascii-Confirm-Delete": id } },
          timeout.deleteVm,
        );
      } catch (error) {
        if (error instanceof ProvisioningError && error.code === "missing") {
          journalCaught(error, "boat.deleteVm", null);
          return "missing";
        }
        throw error;
      }
      return "deleted";
    },
  };
}

const AUTO_STOP_CODE = "trial_auto_stop_required";

async function bearer(operation: ProvisioningOperation, read: ExeDevTokenReader): Promise<string> {
  let token: string | null;
  try {
    token = await read();
  } catch (error) {
    journalCaught(error, "boat.bearer.read", null);
    token = null;
  }
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed.length === 0 || !TOKEN.test(trimmed))
    throw new ProvisioningError(
      operation,
      "no_token",
      `boat ${operation}: the boat key is missing or unreadable. Save it on Settings › Runner VMs.`,
    );
  return trimmed;
}

function codeFor(status: number): ProvisioningErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "missing";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "unknown";
}

function httpError(
  operation: ProvisioningOperation,
  vm: string,
  status: number,
  body: unknown,
  token: string,
): ProvisioningError {
  const code = codeFor(status);
  const said = record(body);
  const boatCode = typeof said?.["code"] === "string" ? said["code"] : null;
  const message = typeof said?.["message"] === "string" ? said["message"] : null;
  const text = [boatCode, message].filter((part) => part !== null).join(": ");
  return new ProvisioningError(
    operation,
    code,
    `boat ${operation} for ${vm} failed with HTTP ${status} (${code}).`,
    status,
    text.length === 0 ? null : clean(text, token),
  );
}

function clean(text: string, token: string): string {
  const said = Array.from(text.replaceAll(token, "[redacted]"), (char) =>
    char < " " || char === "\u007f" ? " " : char,
  )
    .join("")
    .trim();
  return said.length > MAX_DETAIL ? `${said.slice(0, MAX_DETAIL - 1)}…` : said;
}

function invalid(operation: ProvisioningOperation, vm: string, status: number): ProvisioningError {
  return new ProvisioningError(
    operation,
    "invalid_response",
    `boat ${operation} for ${vm}: the response did not have the expected shape.`,
    status,
  );
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    journalCaught(error, "boat.parseJson", null);
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
