import { eq } from "drizzle-orm";
import type { Db } from "./db";

export function githubBlobCache(store: Db, now: () => number = Date.now) {
  return {
    get: (sha: string): Promise<Uint8Array | null> =>
      store.run(function* (q) {
        const { githubBlob } = q.t;
        const row = yield* q.one(
          q.orm
            .select({ content: githubBlob.content })
            .from(githubBlob)
            .where(eq(githubBlob.sha, sha)),
        );
        return row ? new Uint8Array(Buffer.from(row.content, "base64")) : null;
      }),
    put: (sha: string, bytes: Uint8Array): Promise<void> =>
      store.run(function* (q) {
        const { githubBlob } = q.t;
        yield* q.exec(
          q.orm
            .insert(githubBlob)
            .values({ sha, content: Buffer.from(bytes).toString("base64"), cachedAt: now() })
            .onConflictDoNothing(),
        );
      }),
  };
}
