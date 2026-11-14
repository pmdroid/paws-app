import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type { RunnerAccount } from "./accounts";
import type { RunnerCodingAgent } from "./agents";

export const RUNNER_AGENT_CREDENTIAL_FILES: Record<RunnerCodingAgent, readonly string[]> = {
  claude: [".claude/.credentials.json", ".claude/.claude.json"],
  codex: [".codex/auth.json"],
  grok: [".grok/auth.json"],
  opencode: [".local/share/opencode/auth.json"],
};

export const RunnerAgentCredentialFilesSchema = z
  .array(
    z.strictObject({
      path: z.enum(Object.values(RUNNER_AGENT_CREDENTIAL_FILES).flat() as [string, ...string[]]),
      data: z.base64().max(262_144),
    }),
  )
  .max(4);

export const RunnerAgentCredentialSchema = z.strictObject({
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sealed: z.base64url().max(1_048_576).optional(),
});

export const RunnerAgentCredentialUploadSchema = z.strictObject({
  accountId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  files: RunnerAgentCredentialFilesSchema,
});

export const RunnerAgentCredentialReceiptSchema = z.strictObject({
  result: z.enum(["written", "not_holder", "stale_version"]),
});

export type RunnerAgentCredentialFiles = z.infer<typeof RunnerAgentCredentialFilesSchema>;
export type RunnerAgentCredential = z.infer<typeof RunnerAgentCredentialSchema>;

export type RunnerAgentCredentialStore = {
  write(account: RunnerAccount, agent: RunnerCodingAgent, files: RunnerAgentCredentialFiles): void;
  busy(account: RunnerAccount): boolean;
  remove(account: RunnerAccount, agent: RunnerCodingAgent): void;
};

export function agentCredentialDigest(files: RunnerAgentCredentialFiles): string {
  return createHash("sha256")
    .update(JSON.stringify(files.toSorted((a, b) => a.path.localeCompare(b.path))))
    .digest("hex");
}

const HKDF_INFO = Buffer.from("paws-runner-agent-credential-v1");

function contentKey(secret: Buffer, ephemeral: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, ephemeral, HKDF_INFO, 32));
}

export function sealForRunner(certificatePem: string, plaintext: string, context: string): string {
  const recipient = new X509Certificate(certificatePem).publicKey;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ephemeral = publicKey.export({ type: "spki", format: "der" });
  const key = contentKey(diffieHellman({ privateKey, publicKey: recipient }), ephemeral);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(ephemeral.length);
  return Buffer.concat([header, ephemeral, iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openForRunner(privateKey: string | KeyObject, sealed: string, context: string) {
  const bytes = Buffer.from(sealed, "base64url");
  const length = bytes.readUInt16BE(0);
  const ephemeral = bytes.subarray(2, 2 + length);
  const iv = bytes.subarray(2 + length, 14 + length);
  const tag = bytes.subarray(14 + length, 30 + length);
  const own = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const peer = createPublicKey({ key: ephemeral, format: "der", type: "spki" });
  const key = contentKey(diffieHellman({ privateKey: own, publicKey: peer }), ephemeral);
  const decipher = createDecipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes.subarray(30 + length)), decipher.final()]).toString(
    "utf8",
  );
}

export function agentCredentialContext(commandId: string, accountId: string, version: number) {
  return `paws-agent-credential:${commandId}:${accountId}:${version}`;
}

export function agentCredentialReturnContext(executionId: string) {
  return `paws-agent-credential-return:${executionId}`;
}
