import { readFileSync } from "node:fs";
import { join } from "node:path";

export { demoStatus } from "./status";
export type { StatusItem, StatusReport, StatusRun } from "./status";

/** Static dashboard shell. It loads live rows from `/api/status` and falls back to demo data. */
export const statusPageHtml = readFileSync(join(import.meta.dir, "status.html"), "utf8");

export function statusResponse(): Response {
  return new Response(statusPageHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
