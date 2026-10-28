/**
 * `[member_vm]`: the size Create VM asks exe.dev for. The keys follow `ssh exe.dev help new`:
 * `--cpu`, `--memory`, `--disk`, `--image` and `--pool`. A missing key sends no flag, so exe.dev
 * uses its default (2 CPUs, the team's VM placement). exe.dev enforces the plan limits and the
 * pool's capacity, and Paws shows its refusal.
 */
export type MemberVmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  /** The exe.dev pool Create VM places runner VMs in, unless the member picks another. */
  pool?: string;
};

const MEMBER_VM_KEYS = ["cpu", "memory_gb", "disk_gb", "image", "pool"] as const;

/** Upper bounds that catch typos. exe.dev's plan limits are lower and it says so itself. */
const MAX_MEMBER_VM_CPU = 512;
const MAX_MEMBER_VM_MEMORY_GB = 4096;
const MAX_MEMBER_VM_DISK_GB = 65_536;

/** A Docker image reference, without anything a shell or exe.dev's parser would split on. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

function isMemberVmImage(value: string): boolean {
  return IMAGE.test(value);
}

/** An exe.dev pool name: letters, digits, `-` and `_`, as `pool list` shows it. */
const POOL = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;

export function isMemberVmPool(value: unknown): value is string {
  return typeof value === "string" && POOL.test(value);
}

export type MemberVmKey = (typeof MEMBER_VM_KEYS)[number];

export function isMemberVmKey(key: string): key is MemberVmKey {
  return (MEMBER_VM_KEYS as readonly string[]).includes(key);
}

/** Assign one `[member_vm]` key, or throw with the line number. */
export function assignMemberVmKey(
  size: MemberVmSize,
  key: string,
  value: string | number | boolean | string[],
  line: number,
): void {
  if (!isMemberVmKey(key))
    throw new Error(
      `config.toml line ${line} has an unknown key: member_vm.${key} (use ${MEMBER_VM_KEYS.join(", ")})`,
    );
  let checked: number | string;
  try {
    checked = checkMemberVmValue(key, value);
  } catch (error) {
    throw new Error(`config.toml line ${line} ${(error as Error).message}`, { cause: error });
  }
  if (key === "cpu") size.cpu = checked as number;
  else if (key === "memory_gb") size.memoryGb = checked as number;
  else if (key === "disk_gb") size.diskGb = checked as number;
  else if (key === "image") size.image = checked as string;
  else size.pool = checked as string;
}

/** One `[member_vm]` value, checked as config.toml and `paws install` take it. */
export function checkMemberVmValue(
  key: MemberVmKey,
  value: string | number | boolean | string[],
): number | string {
  if (key === "cpu") return positive(value, key, MAX_MEMBER_VM_CPU);
  if (key === "memory_gb") return positive(value, key, MAX_MEMBER_VM_MEMORY_GB);
  if (key === "disk_gb") return positive(value, key, MAX_MEMBER_VM_DISK_GB);
  if (key === "pool") {
    if (!isMemberVmPool(value))
      throw new Error(
        'member_vm.pool must be an exe.dev pool name such as "build" (letters, digits, - and _)',
      );
    return value;
  }
  if (typeof value !== "string" || !isMemberVmImage(value))
    throw new Error('member_vm.image must be an image name such as "ubuntu:24.04"');
  return value;
}

function positive(value: string | number | boolean | string[], key: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`member_vm.${key} must be a whole number from 1 to ${max}`);
  return value;
}

export function renderMemberVmSettings(size: MemberVmSize | undefined): string {
  const lines = [
    ...(size?.cpu === undefined ? [] : [`cpu = ${size.cpu}`]),
    ...(size?.memoryGb === undefined ? [] : [`memory_gb = ${size.memoryGb}`]),
    ...(size?.diskGb === undefined ? [] : [`disk_gb = ${size.diskGb}`]),
    ...(size?.image === undefined ? [] : [`image = "${size.image}"`]),
    ...(size?.pool === undefined ? [] : [`pool = "${size.pool}"`]),
  ];
  return lines.length ? `\n[member_vm]\n${lines.join("\n")}\n` : "";
}
