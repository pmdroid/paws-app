import {
  checkVmSizeIn,
  EXE_DEV_LIMITS,
  fixedVmSizes,
  loadConfigFile,
  MEMBER_VM_PROVIDERS,
  parseVmSizesSettings,
  vmSizeFor,
  writeVmSizes,
  type VmSizeChoice,
  type VmSizes,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const VM_SIZES_SETTINGS_PATH = "/api/settings/vm-sizes";

const NO_INSTABOX_KEY = "Save an InstaBox key to list sizes";

export type VmSizesSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  instaBoxSizes?: () => Promise<VmSizeChoice[] | null>;
  audit: (action: string, subject: string) => Promise<void>;
};

type InstaBoxListing = { sizes: VmSizeChoice[] } | { note: string };

export async function handleVmSizesSettingsRequest(
  request: Request,
  options: VmSizesSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== VM_SIZES_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "VM size settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change VM sizes." }, 403);
  if (request.method === "GET") return listing(options);
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let settings: VmSizes;
  try {
    settings = parseVmSizesSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "vm-sizes.handleVmSizesSettingsRequest.parse", null);
    return json({ error: error instanceof Error ? error.message : "Invalid VM sizes" }, 400);
  }
  const saved = savedVmSizes(options.configPath);
  const offProviders = settings.offProviders ?? saved?.offProviders;
  if (offProviders !== undefined) settings.offProviders = offProviders;
  const instaBox = vmSizeFor(settings, "instabox");
  const savedInstaBox = vmSizeFor(saved, "instabox");
  if (
    Object.keys(instaBox).length > 0 &&
    (instaBox.cpu !== savedInstaBox.cpu || instaBox.memoryGb !== savedInstaBox.memoryGb)
  ) {
    const listed = await instaBoxListing(options);
    if ("note" in listed) return json({ error: `${listed.note}.` }, 400);
    try {
      checkVmSizeIn("InstaBox", instaBox, listed.sizes);
    } catch (error) {
      journalCaught(error, "vm-sizes.handleVmSizesSettingsRequest.instabox", null);
      return json({ error: (error as Error).message }, 400);
    }
  }
  await writeVmSizes(options.configPath, settings);
  const described = MEMBER_VM_PROVIDERS.flatMap((provider) => {
    const size = Object.entries(vmSizeFor(settings, provider));
    return size.length
      ? [`${provider} ${size.map(([key, value]) => `${key} ${value}`).join(" ")}`]
      : [];
  }).join(", ");
  await options.audit("settings.vm_sizes", `Set VM sizes: ${described || "provider defaults"}`);
  return listing(options);
}

async function listing(options: VmSizesSettingsOptions): Promise<Response> {
  let settings: VmSizes | undefined;
  try {
    settings = loadConfigFile(options.configPath).vmSizes;
  } catch (error) {
    journalCaught(error, "vm-sizes.listing", null);
    return json({ error: "VM size settings could not be read" }, 503);
  }
  const instaBox = await instaBoxListing(options);
  return json({
    ...(settings?.provider === undefined ? {} : { provider: settings.provider }),
    ...(settings?.offProviders === undefined ? {} : { offProviders: settings.offProviders }),
    providers: {
      "exe-dev": { size: vmSizeFor(settings, "exe-dev"), limits: EXE_DEV_LIMITS },
      boat: { size: vmSizeFor(settings, "boat"), allowed: fixedVmSizes("boat") },
      instabox: {
        size: vmSizeFor(settings, "instabox"),
        ...("note" in instaBox ? { note: instaBox.note } : { allowed: instaBox.sizes }),
      },
    },
  });
}

async function instaBoxListing(options: VmSizesSettingsOptions): Promise<InstaBoxListing> {
  try {
    const sizes = (await options.instaBoxSizes?.()) ?? null;
    return sizes === null ? { note: NO_INSTABOX_KEY } : { sizes };
  } catch (error) {
    journalCaught(error, "vm-sizes.instaBoxListing", null);
    return { note: `InstaBox sizes could not be read: ${(error as Error).message}` };
  }
}

function savedVmSizes(configPath: string): VmSizes | undefined {
  try {
    return loadConfigFile(configPath).vmSizes;
  } catch (error) {
    journalCaught(error, "vm-sizes.savedVmSizes", null);
    return undefined;
  }
}
