import { ProvisioningError } from "./types";
import type { CreateVm, ExecVm, ProviderOperation } from "./types";

export function validName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function invalid(operation: ProviderOperation): never {
  throw new ProvisioningError(operation, "invalid_input", "not_sent");
}

export function createCommand(input: CreateVm): string {
  if (
    !validName(input.name) ||
    !Number.isSafeInteger(input.cpu) ||
    input.cpu < 1 ||
    input.cpu > 512 ||
    !Number.isSafeInteger(input.memoryGB) ||
    input.memoryGB < 1 ||
    input.memoryGB > 4096 ||
    (input.pool !== undefined && !validName(input.pool)) ||
    (input.image !== undefined &&
      (typeof input.image !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,511}$/.test(input.image)))
  )
    invalid("create");
  const parts = [
    "new",
    `--name=${quote(input.name)}`,
    `--cpu=${input.cpu}`,
    `--memory=${input.memoryGB}GB`,
  ];
  if (input.pool !== undefined) parts.push(`--pool=${quote(input.pool)}`);
  if (input.image !== undefined) parts.push(`--image=${quote(input.image)}`);
  return parts.join(" ");
}

export function execCommand(input: ExecVm): string {
  if (
    !validName(input.vmName) ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.includes("\0")
  )
    invalid("exec");
  const command = `ssh ${quote(input.vmName)} ${quote(input.command)}`;
  if (Buffer.byteLength(command) > 64 * 1024) invalid("exec");
  return command;
}
