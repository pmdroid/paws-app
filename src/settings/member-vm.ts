import {
  BOAT_SIZES,
  checkVmSizeIn,
  loadConfigFile,
  parseMemberVmSettings,
  updateVmSizes,
  vmSizeFor,
  type VmSizes,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const MEMBER_VM_SETTINGS_PATH = "/api/settings/vm-sizes";

export type MemberVmSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  instaBoxSizes?: () => Promise<[number, number][] | null>;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleMemberVmSettingsRequest(
  request: Request,
  options: MemberVmSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== MEMBER_VM_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Member VM settings are only available on the local Paws origin" }, 403);
  const listing = async () => {
    let settings: VmSizes | undefined;
    try {
      settings = loadConfigFile(options.configPath).vmSizes;
    } catch (error) {
      journalCaught(error, "member-vm.handleMemberVmSettingsRequest.read", null);
      return json({ error: "VM size settings could not be read" }, 503);
    }
    const instaBox = await instaBoxSizes(options);
    return json({
      ...(settings?.provider === undefined ? {} : { provider: settings.provider }),
      ...(settings?.offProviders === undefined ? {} : { offProviders: settings.offProviders }),
      providers: {
        "exe-dev": {
          size: vmSizeFor(settings, "exe-dev"),
          limits: { cpu: 512, memoryGb: 4096, diskGb: 65_536 },
        },
        boat: { size: vmSizeFor(settings, "boat"), allowed: BOAT_SIZES },
        instabox: {
          size: vmSizeFor(settings, "instabox"),
          ...(typeof instaBox === "string" ? { note: instaBox } : { allowed: instaBox }),
        },
      },
    });
  };
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change VM sizes." }, 403);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: VmSizes;
  try {
    body = parseMemberVmSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "member-vm.handleMemberVmSettingsRequest.parse", null);
    return json({ error: error instanceof Error ? error.message : "Invalid member VM size" }, 400);
  }
  const instaBox = body.sizes?.instabox ?? {};
  if (instaBox.cpu !== undefined || instaBox.memoryGb !== undefined) {
    const allowed = await instaBoxSizes(options);
    if (typeof allowed === "string") return json({ error: `${allowed}.` }, 400);
    try {
      checkVmSizeIn("InstaBox", instaBox, allowed);
    } catch (error) {
      journalCaught(error, "member-vm.handleMemberVmSettingsRequest.instabox", null);
      return json({ error: (error as Error).message }, 400);
    }
  }
  await updateVmSizes(options.configPath, (saved) => ({
    ...saved,
    ...body,
    sizes: { ...saved.sizes, ...body.sizes },
  }));
  const described = Object.entries(body.sizes ?? {})
    .map(([provider, size]) => `${provider} ${JSON.stringify(size)}`)
    .join(", ");
  await options.audit("settings.vm_sizes", `Set VM sizes: ${described || "no size changed"}`);
  return listing();
}

async function instaBoxSizes(
  options: MemberVmSettingsOptions,
): Promise<[number, number][] | string> {
  try {
    return (await options.instaBoxSizes?.()) ?? "Save an InstaBox key to list sizes";
  } catch (error) {
    journalCaught(error, "member-vm.instaBoxSizes", null);
    return `InstaBox sizes could not be read: ${(error as Error).message}`;
  }
}
