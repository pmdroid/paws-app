import { updateConfigText, withoutConfigSection } from "./settings-store";

/**
 * `[member_vm]`: the size Create VM asks exe.dev for. The keys follow `ssh exe.dev help new`:
 * `--cpu`, `--memory`, `--disk`, `--image` and `--pool`. A missing key sends no flag, so exe.dev
 * uses its default (2 CPUs, the team's VM placement). exe.dev enforces the plan limits and the
 * pool's capacity, and Paws shows its refusal.
 */
export const MEMBER_VM_PROVIDERS = ["exe-dev", "boat", "instabox"] as const;
export type MemberVmProviderName = (typeof MEMBER_VM_PROVIDERS)[number];

export type MemberVmSize = {
  provider?: MemberVmProviderName;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  /** The exe.dev pool Create VM places runner VMs in, unless the member picks another. */
  pool?: string;
  offProviders?: MemberVmProviderName[];
};

const MEMBER_VM_KEYS = [
  "provider",
  "cpu",
  "memory_gb",
  "disk_gb",
  "image",
  "pool",
  "off_providers",
] as const;

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
      `Saved settings line ${line} has an unknown key: member_vm.${key} (use ${MEMBER_VM_KEYS.join(", ")})`,
    );
  let checked: number | string | MemberVmProviderName[];
  try {
    checked = checkMemberVmValue(key, value);
  } catch (error) {
    throw new Error(`Saved settings line ${line} ${(error as Error).message}`, { cause: error });
  }
  if (key === "provider") size.provider = checked as MemberVmProviderName;
  else if (key === "cpu") size.cpu = checked as number;
  else if (key === "memory_gb") size.memoryGb = checked as number;
  else if (key === "disk_gb") size.diskGb = checked as number;
  else if (key === "image") size.image = checked as string;
  else if (key === "off_providers") size.offProviders = checked as MemberVmProviderName[];
  else size.pool = checked as string;
}

/** One `[member_vm]` value, checked as Settings and `paws install` take it. */
export function checkMemberVmValue(
  key: MemberVmKey,
  value: string | number | boolean | string[],
): number | string | MemberVmProviderName[] {
  if (key === "off_providers") {
    if (
      !Array.isArray(value) ||
      !value.every((id) => (MEMBER_VM_PROVIDERS as readonly unknown[]).includes(id))
    )
      throw new Error('member_vm.off_providers must be a list of "exe-dev", "boat" or "instabox"');
    return [...new Set(value as MemberVmProviderName[])];
  }
  if (key === "provider") {
    if (!(MEMBER_VM_PROVIDERS as readonly unknown[]).includes(value))
      throw new Error("member_vm.provider must be exe-dev, boat or instabox");
    return value as MemberVmProviderName;
  }
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
    ...(size?.provider === undefined ? [] : [`provider = "${size.provider}"`]),
    ...(size?.cpu === undefined ? [] : [`cpu = ${size.cpu}`]),
    ...(size?.memoryGb === undefined ? [] : [`memory_gb = ${size.memoryGb}`]),
    ...(size?.diskGb === undefined ? [] : [`disk_gb = ${size.diskGb}`]),
    ...(size?.image === undefined ? [] : [`image = "${size.image}"`]),
    ...(size?.pool === undefined ? [] : [`pool = "${size.pool}"`]),
    ...(size?.offProviders?.length
      ? [`off_providers = [${size.offProviders.map((id) => `"${id}"`).join(", ")}]`]
      : []),
  ];
  return lines.length ? `\n[member_vm]\n${lines.join("\n")}\n` : "";
}

export function parseMemberVmSettings(value: unknown): MemberVmSize {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("member_vm must be an object");
  const field = (key: string) => key.replace(/_(\w)/, (_, letter: string) => letter.toUpperCase());
  const fields = MEMBER_VM_KEYS.map(field);
  const unknown = Object.keys(value).find((name) => !(fields as string[]).includes(name));
  if (unknown !== undefined)
    throw new Error(`member_vm has an unknown field: ${unknown} (use ${fields.join(", ")})`);
  const size: Record<string, number | string | MemberVmProviderName[]> = {};
  for (const key of MEMBER_VM_KEYS) {
    const raw = (value as Record<string, unknown>)[field(key)];
    if (raw !== undefined && raw !== null)
      size[field(key)] = checkMemberVmValue(key, raw as string | number | boolean | string[]);
  }
  checkMemberVmSize(memberVmProvider(size), size);
  return size as MemberVmSize;
}

export function memberVmProvider(settings: MemberVmSize | undefined): MemberVmProviderName {
  return settings?.provider ?? "exe-dev";
}

export function memberVmSizeOnly(
  settings: MemberVmSize | undefined,
): Omit<MemberVmSize, "provider" | "offProviders"> {
  const { provider: _provider, offProviders: _off, ...size } = settings ?? {};
  return size;
}

const FIXED_SIZES = {
  boat: {
    name: "boat",
    pairs: [
      [2, 4],
      [4, 8],
      [8, 16],
      [16, 32],
    ],
    maxDiskGb: null,
  },
  instabox: {
    name: "InstaBox",
    pairs: [
      [2, 4],
      [4, 8],
      [8, 16],
      [16, 32],
      [32, 64],
    ],
    maxDiskGb: 1024,
  },
} as const;

export function checkMemberVmSize(
  provider: MemberVmProviderName,
  size: Omit<MemberVmSize, "provider" | "offProviders">,
): void {
  if (provider === "exe-dev") return;
  const { name, pairs, maxDiskGb } = FIXED_SIZES[provider];
  const unsupported = (
    [
      ["image", size.image],
      ["pool", size.pool],
      ["disk_gb", maxDiskGb === null ? size.diskGb : undefined],
    ] as const
  ).find(([, value]) => value !== undefined && value !== null);
  if (unsupported !== undefined)
    throw new Error(
      `${name} has no ${unsupported[0]} setting. Remove member_vm.${unsupported[0]}.`,
    );
  if (maxDiskGb !== null && size.diskGb !== undefined && size.diskGb > maxDiskGb)
    throw new Error(`${name} has no ${size.diskGb} GB data disk. Use 1 to ${maxDiskGb}.`);
  if (size.cpu === undefined && size.memoryGb === undefined) return;
  if (pairs.some(([cpu, memory]) => cpu === size.cpu && memory === size.memoryGb)) return;
  const sizes = pairs.map(([cpu, memory]) => `${cpu}/${memory}`);
  const allowed = `${sizes.slice(0, -1).join(", ")} or ${sizes.at(-1)}`;
  const asked =
    size.cpu === undefined
      ? `${size.memoryGb} GB size without cpu`
      : size.memoryGb === undefined
        ? `${size.cpu} vCPU size without memory_gb`
        : `${size.cpu} vCPU / ${size.memoryGb} GB size`;
  throw new Error(`${name} has no ${asked}. Use ${allowed}.`);
}

export function setMemberVmText(current: string, size: MemberVmSize): string {
  const retained = withoutConfigSection(current, "member_vm");
  const table = renderMemberVmSettings(size);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}

export function writeMemberVmSize(path: string, size: MemberVmSize): Promise<void> {
  return updateConfigText(path, (text) => setMemberVmText(text, size));
}
