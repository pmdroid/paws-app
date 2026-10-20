import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile, writeSecretFile } from "./files";

export function memberGitHubSecrets(secretsDir: string, workspaceId: string, userId: string) {
  const prefix = createHash("sha256")
    .update(JSON.stringify([workspaceId, userId]))
    .digest("hex");
  function path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid member credential reference.");
    return join(secretsDir, `member-github-${prefix}-${id}`);
  }
  return {
    write(token: string): string {
      const id = randomUUID();
      writeSecretFile(path(id), token, true);
      return id;
    },
    read(id: string): string | null {
      const file = path(id);
      if (!existsSync(file)) return null;
      if (!readFileSync(file, "utf8").startsWith("paws-envelope-v1\n"))
        throw new Error("Encrypted member credential required.");
      return readSecretFile(file, false);
    },
    remove(id: string) {
      rmSync(path(id), { force: true });
    },
  };
}
