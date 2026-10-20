import { createCommand, execCommand, validName } from "./commands";
import { ProvisioningError } from "./types";
import type { ExeDev, ExecResult, ProviderOperation, Vm } from "./types";

export type ExeDevOptions = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readToken: () => Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed(operation: ProviderOperation): never {
  throw new ProvisioningError(operation, "invalid_response", "unknown");
}

function json(text: string, operation: ProviderOperation): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return malformed(operation);
  }
}

function vm(value: unknown, operation: ProviderOperation): Vm {
  if (!object(value) || !validName(value.vm_name) || "error" in value) malformed(operation);
  const result: Vm = { name: value.vm_name };
  const fields = {
    ssh_dest: "sshDestination",
    ssh_host: "sshHost",
    ssh_user: "sshUser",
    https_url: "httpsUrl",
    status: "status",
  } as const;
  for (const [source, target] of Object.entries(fields)) {
    const field = value[source];
    if (field === undefined) continue;
    if (
      typeof field !== "string" ||
      !field ||
      [...field].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    )
      malformed(operation);
    result[target] = field;
  }
  return result;
}

function execution(text: string, maxBytes: number): ExecResult {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let exitCode: number | undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (exitCode !== undefined) malformed("exec");
    const record = json(line, "exec");
    if (!object(record) || Object.keys(record).length !== 1) malformed("exec");
    if ("error" in record) {
      throw new ProvisioningError("exec", "incomplete_exec", "unknown");
    }
    if ("exit_code" in record) {
      if (
        !Number.isInteger(record.exit_code) ||
        (record.exit_code as number) < 0 ||
        (record.exit_code as number) > 255
      )
        malformed("exec");
      exitCode = record.exit_code as number;
      continue;
    }
    const stream = "stdout" in record ? "stdout" : "stderr";
    const encoded = record[stream];
    if (
      typeof encoded !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      malformed("exec");
    const chunk = Buffer.from(encoded, "base64");
    if (chunk.toString("base64") !== encoded) malformed("exec");
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ProvisioningError("exec", "output_limit", "unknown");
    (stream === "stdout" ? stdout : stderr).push(chunk);
  }
  if (exitCode === undefined) throw new ProvisioningError("exec", "incomplete_exec", "unknown");
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode,
  };
}

async function readBody(
  response: Response,
  limit: number,
  operation: ProviderOperation,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) malformed(operation);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > limit) throw new ProvisioningError(operation, "output_limit", "unknown");
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      return malformed(operation);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createExeDev(options: ExeDevOptions): ExeDev {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8 * 1024 * 1024
  ) {
    throw new ProvisioningError("list", "invalid_input", "not_sent");
  }

  async function request<T>(
    operation: ProviderOperation,
    command: string,
    parse: (text: string) => T,
  ): Promise<T> {
    const controller = new AbortController();
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ProvisioningError(operation, "timeout", sent ? "unknown" : "not_sent"));
        controller.abort();
      }, timeoutMs);
    });
    async function send(): Promise<T> {
      let token: string;
      try {
        token = await options.readToken();
        if (
          typeof token !== "string" ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
          Buffer.byteLength(token) > 8192
        )
          throw new Error();
      } catch {
        throw new ProvisioningError(operation, "credentials", "not_sent");
      }
      if (controller.signal.aborted) throw new ProvisioningError(operation, "timeout", "not_sent");
      sent = true;
      const response = await options.fetch("https://exe.dev/exec", {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain",
          Accept: operation === "exec" ? "application/x-ndjson" : "application/json",
        },
        body: command,
        signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const rejected = [400, 401, 403, 404, 405, 413, 429].includes(response.status);
        throw new ProvisioningError(
          operation,
          "http",
          rejected ? "rejected" : "unknown",
          response.status,
        );
      }
      return parse(await readBody(response, maxBytes, operation, controller.signal));
    }
    try {
      return await Promise.race([send(), deadline]);
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError(operation, "transport", sent ? "unknown" : "not_sent");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    listVms() {
      return request("list", "ls --json", (text) => {
        const result = json(text, "list");
        if (!object(result) || !Array.isArray(result.vms) || "error" in result) malformed("list");
        const vms = result.vms.map((value) => vm(value, "list"));
        if (new Set(vms.map((value) => value.name)).size !== vms.length) malformed("list");
        return vms;
      });
    },
    async createVm(input) {
      const command = createCommand(input);
      return request("create", command, (text) => {
        const result = vm(json(text, "create"), "create");
        if (result.name !== input.name) malformed("create");
        return result;
      });
    },
    async execVm(input) {
      return request("exec", execCommand(input), (text) => execution(text, maxBytes));
    },
  };
}
