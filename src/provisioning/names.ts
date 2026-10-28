import { ProvisioningError, type ExeDevVmSize, type ProvisioningOperation } from "./types";

const VM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAX_EXEC_COMMAND_BYTES = 64 * 1024;

export function isExeDevVmName(name: unknown): name is string {
  return typeof name === "string" && VM_NAME.test(name);
}

export function assertVmName(operation: ProvisioningOperation, name: unknown): string {
  if (isExeDevVmName(name)) return name;
  throw new ProvisioningError(
    operation,
    "invalid_name",
    `exe.dev ${operation}: VM name must be 1 to 63 lowercase letters, digits or inner hyphens.`,
  );
}

export function assertCommand(command: unknown): string {
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    command.includes("\0") ||
    Buffer.byteLength(command) > MAX_EXEC_COMMAND_BYTES
  ) {
    throw new ProvisioningError(
      "execVm",
      "invalid_command",
      `exe.dev execVm: command must be non-empty, at most ${MAX_EXEC_COMMAND_BYTES} bytes, and free of NUL bytes.`,
    );
  }
  return command;
}

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

/** `new --name=<vm>` plus a flag for each size field that is set, in `help new` order. */
export function newVmCommand(name: string, size: ExeDevVmSize = {}): string {
  const vm = assertVmName("createVm", name);
  const flags = [`--name=${vm}`];
  if (size.cpu !== undefined) flags.push(`--cpu=${count("cpu", size.cpu)}`);
  if (size.diskGb !== undefined) flags.push(`--disk=${count("disk", size.diskGb)}GB`);
  if (size.image !== undefined) {
    if (!IMAGE.test(size.image))
      throw new ProvisioningError(
        "createVm",
        "invalid_command",
        "exe.dev createVm: the image must be a Docker image name such as ubuntu:24.04.",
      );
    flags.push(`--image=${size.image}`);
  }
  if (size.memoryGb !== undefined) flags.push(`--memory=${count("memory", size.memoryGb)}GB`);
  return `new ${flags.join(" ")}`;
}

function count(flag: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new ProvisioningError(
    "createVm",
    "invalid_command",
    `exe.dev createVm: --${flag} must be a positive whole number.`,
  );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
