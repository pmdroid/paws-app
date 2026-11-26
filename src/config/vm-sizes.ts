import { updateConfigText, withoutConfigSection, type SettingSections } from "./settings-store";

export const MEMBER_VM_PROVIDERS = ["exe-dev", "boat", "instabox"] as const;
export type MemberVmProviderName = (typeof MEMBER_VM_PROVIDERS)[number];

export type VmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  pool?: string;
};

export type VmSizeChoice = { cpu: number; memoryGb: number };

export type VmSizes = {
  provider?: MemberVmProviderName;
  offProviders?: MemberVmProviderName[];
  sizes?: Partial<Record<MemberVmProviderName, VmSize>>;
};

type SizeKey = "cpu" | "memory_gb" | "disk_gb" | "image" | "pool";

const SIZE_KEYS: Record<MemberVmProviderName, readonly SizeKey[]> = {
  "exe-dev": ["cpu", "memory_gb", "disk_gb", "image", "pool"],
  boat: ["cpu", "memory_gb"],
  instabox: ["cpu", "memory_gb"],
};

export const EXE_DEV_LIMITS = { cpu: 512, memoryGb: 4096, diskGb: 65_536 } as const;

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

const POOL = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;

export function isMemberVmPool(value: unknown): value is string {
  return typeof value === "string" && POOL.test(value);
}

const field = (key: string) => key.replace(/_(\w)/, (_, letter: string) => letter.toUpperCase());

function providerValue(value: unknown): MemberVmProviderName {
  if (!(MEMBER_VM_PROVIDERS as readonly unknown[]).includes(value))
    throw new Error("vm_sizes.provider must be exe-dev, boat or instabox");
  return value as MemberVmProviderName;
}

function offProvidersValue(value: unknown): MemberVmProviderName[] {
  if (!Array.isArray(value) || !value.every((id) => MEMBER_VM_PROVIDERS.includes(id)))
    throw new Error('vm_sizes.off_providers must be a list of "exe-dev", "boat" or "instabox"');
  return [...new Set(value as MemberVmProviderName[])];
}

function sizeValue(provider: MemberVmProviderName, key: SizeKey, value: unknown): number | string {
  const name = `vm_sizes.${provider}.${key}`;
  if (key === "pool") {
    if (!isMemberVmPool(value))
      throw new Error(
        `${name} must be an exe.dev pool name such as "build" (letters, digits, - and _)`,
      );
    return value;
  }
  if (key === "image") {
    if (typeof value !== "string" || !IMAGE.test(value))
      throw new Error(`${name} must be an image name such as "ubuntu:24.04"`);
    return value;
  }
  const max = EXE_DEV_LIMITS[field(key) as keyof typeof EXE_DEV_LIMITS];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  return value;
}

export function assignVmSizesKey(
  settings: VmSizes,
  section: string,
  key: string,
  value: unknown,
  line: number,
): void {
  try {
    if (section === "vm_sizes") {
      if (key === "provider") settings.provider = providerValue(value);
      else if (key === "off_providers") settings.offProviders = offProvidersValue(value);
      else throw new Error(`has an unknown key: vm_sizes.${key} (use provider, off_providers)`);
      return;
    }
    const provider = providerValue(section.slice("vm_sizes.".length));
    const keys = SIZE_KEYS[provider];
    if (!(keys as readonly string[]).includes(key))
      throw new Error(`has an unknown key: ${section}.${key} (use ${keys.join(", ")})`);
    const size = ((settings.sizes ??= {})[provider] ??= {}) as Record<string, number | string>;
    size[field(key)] = sizeValue(provider, key as SizeKey, value);
  } catch (error) {
    throw new Error(`Saved settings line ${line} ${(error as Error).message}`, { cause: error });
  }
}

function record(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined)
    throw new Error(`${name} has an unknown field: ${unknown} (use ${fields.join(", ")})`);
  return value as Record<string, unknown>;
}

export function parseVmSizesSettings(value: unknown): VmSizes {
  const body = record(value, "vm_sizes", ["provider", "offProviders", "sizes"]);
  const settings: VmSizes = {};
  if (body.provider != null) settings.provider = providerValue(body.provider);
  if (body.offProviders != null) settings.offProviders = offProvidersValue(body.offProviders);
  const sizes = body.sizes == null ? {} : record(body.sizes, "vm_sizes.sizes", MEMBER_VM_PROVIDERS);
  for (const provider of MEMBER_VM_PROVIDERS) {
    if (sizes[provider] == null) continue;
    const keys = SIZE_KEYS[provider];
    const raw = record(sizes[provider], `vm_sizes.${provider}`, keys.map(field));
    const size: Record<string, number | string> = {};
    for (const key of keys)
      if (raw[field(key)] != null) size[field(key)] = sizeValue(provider, key, raw[field(key)]);
    if (provider === "boat") checkMemberVmSize("boat", size);
    if (Object.keys(size).length > 0) (settings.sizes ??= {})[provider] = size;
  }
  return settings;
}

export function memberVmProvider(settings: VmSizes | undefined): MemberVmProviderName {
  return settings?.provider ?? "exe-dev";
}

export function vmSizeFor(settings: VmSizes | undefined, provider: MemberVmProviderName): VmSize {
  return { ...settings?.sizes?.[provider] };
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
  },
} as const;

export function fixedVmSizes(provider: "boat"): VmSizeChoice[] {
  return FIXED_SIZES[provider].pairs.map(([cpu, memoryGb]) => ({ cpu, memoryGb }));
}

export function checkMemberVmSize(provider: MemberVmProviderName, size: VmSize): void {
  if (provider === "exe-dev") return;
  const { name, pairs } = FIXED_SIZES[provider];
  checkVmSizeIn(
    name,
    size,
    pairs.map(([cpu, memoryGb]) => ({ cpu, memoryGb })),
  );
}

export function checkVmSizeIn(name: string, size: VmSize, allowed: readonly VmSizeChoice[]): void {
  if (size.cpu === undefined && size.memoryGb === undefined) return;
  if (allowed.some(({ cpu, memoryGb }) => cpu === size.cpu && memoryGb === size.memoryGb)) return;
  const sizes = allowed.map(({ cpu, memoryGb }) => `${cpu}/${memoryGb}`);
  const listed =
    sizes.length < 2
      ? (sizes[0] ?? "no size")
      : `${sizes.slice(0, -1).join(", ")} or ${sizes.at(-1)}`;
  const asked =
    size.cpu === undefined
      ? `${size.memoryGb} GB size without cpu`
      : size.memoryGb === undefined
        ? `${size.cpu} vCPU size without memory_gb`
        : `${size.cpu} vCPU / ${size.memoryGb} GB size`;
  throw new Error(`${name} has no ${asked}. Use ${listed}.`);
}

export function renderVmSizesSettings(settings: VmSizes | undefined): string {
  const top = [
    ...(settings?.provider === undefined ? [] : [`provider = "${settings.provider}"`]),
    ...(settings?.offProviders?.length
      ? [`off_providers = [${settings.offProviders.map((id) => `"${id}"`).join(", ")}]`]
      : []),
  ];
  const tables = MEMBER_VM_PROVIDERS.flatMap((provider) => {
    const size = settings?.sizes?.[provider] ?? {};
    const lines = SIZE_KEYS[provider].flatMap((key) => {
      const value = size[field(key) as keyof VmSize];
      return value === undefined ? [] : [`${key} = ${JSON.stringify(value)}`];
    });
    return lines.length ? [`\n[vm_sizes.${provider}]\n${lines.join("\n")}\n`] : [];
  });
  if (top.length === 0 && tables.length === 0) return "";
  return `\n[vm_sizes]\n${top.length ? `${top.join("\n")}\n` : ""}${tables.join("")}`;
}

export function setVmSizesText(current: string, settings: VmSizes): string {
  const retained = MEMBER_VM_PROVIDERS.reduce(
    (text, provider) => withoutConfigSection(text, `vm_sizes.${provider}`),
    withoutConfigSection(current, "vm_sizes"),
  );
  const table = renderVmSizesSettings(settings);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}

export function writeVmSizes(path: string, settings: VmSizes): Promise<void> {
  return updateConfigText(path, (text) => setVmSizesText(text, settings));
}

export function upgradeSettingSections(sections: SettingSections): SettingSections {
  const { member_vm: legacy, ...rest } = sections;
  if (legacy === undefined) return sections;
  if (rest["vm_sizes"] !== undefined) return rest;
  const old = legacy as Record<string, unknown>;
  const provider = MEMBER_VM_PROVIDERS.includes(old["provider"] as MemberVmProviderName)
    ? (old["provider"] as MemberVmProviderName)
    : "exe-dev";
  const size = Object.fromEntries(
    SIZE_KEYS[provider].filter((key) => old[key] !== undefined).map((key) => [key, old[key]]),
  );
  const vmSizes = {
    ...(old["provider"] === provider ? { provider } : {}),
    ...(old["off_providers"] === undefined ? {} : { off_providers: old["off_providers"] }),
    ...(Object.keys(size).length ? { [provider]: size } : {}),
  };
  return Object.keys(vmSizes).length ? { ...rest, vm_sizes: vmSizes } : rest;
}
