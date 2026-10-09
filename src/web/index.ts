import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Static dashboard shell. Later it can be deployed on its own; the loop does not depend on it. */
export const statusPageHtml = readFileSync(join(import.meta.dir, "status.html"), "utf8");

export function statusResponse(): Response {
  return new Response(statusPageHtml, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
