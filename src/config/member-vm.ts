/**
 * `[member_vm]`: the size Create VM asks exe.dev for. The keys follow `ssh exe.dev help new`:
 * `--cpu`, `--memory`, `--disk` and `--image`. A missing key sends no flag, so exe.dev uses
 * its default (2 CPUs). exe.dev enforces the plan limits and Paws shows its refusal.
 */
export type MemberVmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
};

const MEMBER_VM_KEYS = ["cpu", "memory_gb", "disk_gb", "image"] as const;

/** Upper bounds that catch typos. exe.dev's plan limits are lower and it says so itself. */
const MAX_MEMBER_VM_CPU = 512;
const MAX_MEMBER_VM_MEMORY_GB = 4096;
const MAX_MEMBER_VM_DISK_GB = 65_536;

/** A Docker image reference, without anything a shell or exe.dev's parser would split on. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

function isMemberVmImage(value: string): boolean {
  return IMAGE.test(value);
}

/** Assign one `[member_vm]` key, or throw with the line number. */
export function assignMemberVmKey(
  size: MemberVmSize,
  key: string,
  value: string | number | boolean | string[],
  line: number,
): void {
  if (key === "cpu") size.cpu = positive(value, line, key, MAX_MEMBER_VM_CPU);
  else if (key === "memory_gb") size.memoryGb = positive(value, line, key, MAX_MEMBER_VM_MEMORY_GB);
  else if (key === "disk_gb") size.diskGb = positive(value, line, key, MAX_MEMBER_VM_DISK_GB);
  else if (key === "image") {
    if (typeof value !== "string" || !isMemberVmImage(value))
      throw new Error(
        `config.toml line ${line} member_vm.image must be an image name such as "ubuntu:24.04"`,
      );
    size.image = value;
  } else
    throw new Error(
      `config.toml line ${line} has an unknown key: member_vm.${key} (use ${MEMBER_VM_KEYS.join(", ")})`,
    );
}

function positive(
  value: string | number | boolean | string[],
  line: number,
  key: string,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(
      `config.toml line ${line} member_vm.${key} must be a whole number from 1 to ${max}`,
    );
  return value;
}

export function renderMemberVmSettings(size: MemberVmSize | undefined): string {
  const lines = [
    ...(size?.cpu === undefined ? [] : [`cpu = ${size.cpu}`]),
    ...(size?.memoryGb === undefined ? [] : [`memory_gb = ${size.memoryGb}`]),
    ...(size?.diskGb === undefined ? [] : [`disk_gb = ${size.diskGb}`]),
    ...(size?.image === undefined ? [] : [`image = "${size.image}"`]),
  ];
  return lines.length ? `\n[member_vm]\n${lines.join("\n")}\n` : "";
}
