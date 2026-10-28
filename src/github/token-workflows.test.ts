import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import { mintInstallationToken } from "./token";
import { INSTALLATION_PERMISSIONS, type GitHubClient } from "./types";

const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey as string;

function granted(permissions: Record<string, string>) {
  return {
    token: "ghs_scoped",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    repository_selection: "selected",
    repositories: [{ name: "paws-app", full_name: "pmdroid/paws-app" }],
    permissions: { ...permissions, metadata: "read" },
  };
}

function installation(grantsWorkflows: boolean) {
  const requested: Record<string, string>[] = [];
  const client: GitHubClient = {
    async request(req) {
      const permissions = (req.body as { permissions: Record<string, string> }).permissions;
      requested.push(permissions);
      if (permissions.workflows && !grantsWorkflows)
        return {
          status: 422,
          body: { message: "The permissions requested are not granted to this installation." },
        };
      return { status: 201, body: granted(permissions) };
    },
  };
  return { client, requested };
}

function mint(client: GitHubClient, installationId: string, access?: "read" | "write") {
  return mintInstallationToken({
    client,
    appId: "99",
    installationId,
    privateKeyPem: PRIVATE_KEY,
    owner: "pmdroid",
    repo: "paws-app",
    ...(access ? { access } : {}),
  });
}

test("a write token asks for workflows so Paws can push workflow files", async () => {
  const { client, requested } = installation(true);
  await mint(client, "101");
  expect(requested).toEqual([{ ...INSTALLATION_PERMISSIONS, workflows: "write" }]);
});

test("an installation without workflows gets a token without it, and is not asked again", async () => {
  const { client, requested } = installation(false);
  expect((await mint(client, "102")).token).toBe("ghs_scoped");
  await mint(client, "102");
  expect(requested).toEqual([
    { ...INSTALLATION_PERMISSIONS, workflows: "write" },
    INSTALLATION_PERMISSIONS,
    INSTALLATION_PERMISSIONS,
  ]);
});

test("a read token never asks for workflows", async () => {
  const { client, requested } = installation(true);
  await mint(client, "103", "read");
  expect(requested).toEqual([{ contents: "read", metadata: "read" }]);
});
