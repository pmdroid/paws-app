import { withoutConfigSection, type SettingSections } from "./settings-store";

export const MEMBER_VM_PROVIDERS = ["exe-dev", "boat", "instabox"] as const;
export type MemberVmProviderName = (typeof MEMBER_VM_PROVIDERS)[number];

export type MemberVmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  /** The exe.dev pool Create VM places runner VMs in, unless the member picks another. */
  pool?: string;
};

export type VmSizes = {
  provider?: MemberVmProviderName;
  offProviders?: MemberVmProviderName[];
  sizes?: Partial<Record<MemberVmProviderName, MemberVmSize>>;
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

const SECTION_KEYS: Record<string, readonly MemberVmKey[]> = {
  vm_sizes: ["provider", "off_providers"],
  "vm_sizes.exe-dev": ["cpu", "memory_gb", "disk_gb", "image", "pool"],
  "vm_sizes.boat": ["cpu", "memory_gb"],
  "vm_sizes.instabox": ["cpu", "memory_gb"],
};

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

const field = (key: string) => key.replace(/_(\w)/, (_, letter: string) => letter.toUpperCase());

export function assignMemberVmKey(
  settings: VmSizes,
  section: string,
  key: string,
  value: string | number | boolean | string[],
  line: number,
): void {
  const keys = SECTION_KEYS[section] ?? [];
  if (!(keys as readonly string[]).includes(key))
    throw new Error(
      `Saved settings line ${line} has an unknown key: ${section}.${key} (use ${keys.join(", ")})`,
    );
  let checked: number | string | MemberVmProviderName[];
  try {
    checked = checkMemberVmValue(key as MemberVmKey, value);
  } catch (error) {
    throw new Error(`Saved settings line ${line} ${(error as Error).message}`, { cause: error });
  }
  if (key === "provider") settings.provider = checked as MemberVmProviderName;
  else if (key === "off_providers") settings.offProviders = checked as MemberVmProviderName[];
  else {
    const provider = section.slice("vm_sizes.".length) as MemberVmProviderName;
    const size = ((settings.sizes ??= {})[provider] ??= {}) as Record<string, unknown>;
    size[field(key)] = checked;
  }
}

export function checkMemberVmValue(
  key: MemberVmKey,
  value: string | number | boolean | string[],
): number | string | MemberVmProviderName[] {
  if (key === "off_providers") {
    if (
      !Array.isArray(value) ||
      !value.every((id) => (MEMBER_VM_PROVIDERS as readonly unknown[]).includes(id))
    )
      throw new Error('vm_sizes.off_providers must be a list of "exe-dev", "boat" or "instabox"');
    return [...new Set(value as MemberVmProviderName[])];
  }
  if (key === "provider") {
    if (!(MEMBER_VM_PROVIDERS as readonly unknown[]).includes(value))
      throw new Error("vm_sizes.provider must be exe-dev, boat or instabox");
    return value as MemberVmProviderName;
  }
  if (key === "cpu") return positive(value, key, MAX_MEMBER_VM_CPU);
  if (key === "memory_gb") return positive(value, key, MAX_MEMBER_VM_MEMORY_GB);
  if (key === "disk_gb") return positive(value, key, MAX_MEMBER_VM_DISK_GB);
  if (key === "pool") {
    if (!isMemberVmPool(value))
      throw new Error(
        'vm_sizes.pool must be an exe.dev pool name such as "build" (letters, digits, - and _)',
      );
    return value;
  }
  if (typeof value !== "string" || !isMemberVmImage(value))
    throw new Error('vm_sizes.image must be an image name such as "ubuntu:24.04"');
  return value;
}

function positive(value: string | number | boolean | string[], key: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`vm_sizes.${key} must be a whole number from 1 to ${max}`);
  return value;
}

export function renderMemberVmSettings(settings: VmSizes | undefined): string {
  const top = [
    ...(settings?.provider === undefined ? [] : [`provider = "${settings.provider}"`]),
    ...(settings?.offProviders?.length
      ? [`off_providers = [${settings.offProviders.map((id) => `"${id}"`).join(", ")}]`]
      : []),
  ];
  const tables = MEMBER_VM_PROVIDERS.flatMap((provider) => {
    const size = settings?.sizes?.[provider] ?? {};
    const lines = SECTION_KEYS[`vm_sizes.${provider}`]!.flatMap((key) => {
      const value = size[field(key) as keyof MemberVmSize];
      return value === undefined ? [] : [`${key} = ${JSON.stringify(value)}`];
    });
    return lines.length ? [`\n[vm_sizes.${provider}]\n${lines.join("\n")}\n`] : [];
  });
  if (top.length === 0 && tables.length === 0) return "";
  return `\n[vm_sizes]\n${top.length ? `${top.join("\n")}\n` : ""}${tables.join("")}`;
}

function record(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined)
    throw new Error(`${name} has an unknown field: ${unknown} (use ${fields.join(", ")})`);
  return value as Record<string, unknown>;
}

export function parseMemberVmSettings(value: unknown): VmSizes {
  const body = record(value, "vm_sizes", ["provider", "offProviders", "sizes"]);
  const settings: VmSizes = {};
  if (body.provider != null)
    settings.provider = checkMemberVmValue(
      "provider",
      body.provider as string,
    ) as MemberVmProviderName;
  if (body.offProviders != null)
    settings.offProviders = checkMemberVmValue(
      "off_providers",
      body.offProviders as string[],
    ) as MemberVmProviderName[];
  const sizes = body.sizes == null ? {} : record(body.sizes, "vm_sizes.sizes", MEMBER_VM_PROVIDERS);
  for (const provider of MEMBER_VM_PROVIDERS) {
    if (sizes[provider] == null) continue;
    const keys = SECTION_KEYS[`vm_sizes.${provider}`]!;
    const raw = record(sizes[provider], `vm_sizes.${provider}`, keys.map(field));
    const size: Record<string, number | string> = {};
    for (const key of keys)
      if (raw[field(key)] != null)
        size[field(key)] = checkMemberVmValue(key, raw[field(key)] as number) as number | string;
    checkMemberVmSize(provider, size);
    (settings.sizes ??= {})[provider] = size;
  }
  return settings;
}

export function memberVmProvider(settings: VmSizes | undefined): MemberVmProviderName {
  return settings?.provider ?? "exe-dev";
}

export function vmSizeFor(
  settings: VmSizes | undefined,
  provider: MemberVmProviderName,
): MemberVmSize {
  return { ...settings?.sizes?.[provider] };
}

export const BOAT_SIZES = [
  [2, 4],
  [4, 8],
  [8, 16],
  [16, 32],
] as const;

export function checkMemberVmSize(provider: MemberVmProviderName, size: MemberVmSize): void {
  if (provider === "boat") checkVmSizeIn("boat", size, BOAT_SIZES);
}

export function checkVmSizeIn(
  name: string,
  size: MemberVmSize,
  pairs: readonly (readonly [number, number])[],
): void {
  if (size.cpu === undefined && size.memoryGb === undefined) return;
  if (pairs.some(([cpu, memory]) => cpu === size.cpu && memory === size.memoryGb)) return;
  const sizes = pairs.map(([cpu, memory]) => `${cpu}/${memory}`);
  const allowed =
    sizes.length < 2
      ? (sizes[0] ?? "no size")
      : `${sizes.slice(0, -1).join(", ")} or ${sizes.at(-1)}`;
  const asked =
    size.cpu === undefined
      ? `${size.memoryGb} GB size without cpu`
      : size.memoryGb === undefined
        ? `${size.cpu} vCPU size without memory_gb`
        : `${size.cpu} vCPU / ${size.memoryGb} GB size`;
  throw new Error(`${name} has no ${asked}. Use ${allowed}.`);
}

export function setMemberVmText(current: string, settings: VmSizes): string {
  const retained = MEMBER_VM_PROVIDERS.reduce(
    (text, provider) => withoutConfigSection(text, `vm_sizes.${provider}`),
    withoutConfigSection(current, "vm_sizes"),
  );
  const table = renderMemberVmSettings(settings);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}

export function upgradeSettingSections(sections: SettingSections): SettingSections {
  const { member_vm: legacy, ...rest } = sections;
  if (legacy === undefined) return sections;
  if (rest["vm_sizes"] !== undefined) return rest;
  const old = legacy as Record<string, unknown>;
  const provider = MEMBER_VM_PROVIDERS.includes(old["provider"] as MemberVmProviderName)
    ? (old["provider"] as MemberVmProviderName)
    : "exe-dev";
  const keys = SECTION_KEYS[`vm_sizes.${provider}`]!.filter((key) => old[key] !== undefined);
  const vmSizes = {
    ...(old["provider"] === provider ? { provider } : {}),
    ...(old["off_providers"] === undefined ? {} : { off_providers: old["off_providers"] }),
    ...(keys.length ? { [provider]: Object.fromEntries(keys.map((key) => [key, old[key]])) } : {}),
  };
  return Object.keys(vmSizes).length ? { ...rest, vm_sizes: vmSizes } : rest;
}
