import { rmSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile, removeSecret, saveSecret } from "../credentials";

function tokenFile(secretsDir: string): string {
  return join(secretsDir, "setup-token");
}

export async function setupToken(secretsDir: string): Promise<string> {
  const saved = readSecretFile(tokenFile(secretsDir))?.trim();
  if (saved) return saved;
  const token = crypto.randomUUID() + crypto.randomUUID();
  await saveSecret(tokenFile(secretsDir), token);
  return token;
}

export async function forgetSetupToken(secretsDir: string): Promise<void> {
  await removeSecret(tokenFile(secretsDir));
  rmSync(tokenFile(secretsDir), { force: true });
}

export function setupLink(secretsDir: string, publicUrl: string | null): string {
  const token = readSecretFile(tokenFile(secretsDir), false)?.trim();
  if (!token) return "Setup is complete.";
  return (publicUrl ?? "") + "/setup?token=" + token;
}

export function setupNeededPage(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set up Paws</title></head>
<body>
<main>
<h1>Paws needs setup</h1>
<p>Finish setup in this browser with the setup link. Paws printed it when it started.</p>
<p>To see the link again, run <code>paws setup-link</code> on the server.</p>
</main>
</body>
</html>`,
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
