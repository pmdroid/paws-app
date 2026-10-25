import { ProvisioningError, type ProvisioningOperation } from "./types";

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

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
