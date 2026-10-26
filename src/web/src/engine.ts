/**
 * In-module barrel for status tests. Other modules import `src/web` only.
 *
 * Call `handleStatusRequest` from the engine HTTP server. Return value `null`
 * means the request is not a status route (leave webhooks and everything else
 * alone). `/api/status` reads `createLiveStatusProvider(db)` (`source: "live"`).
 */
export { STATUS_API_PATH, STATUS_PAGE_PATH, parseStatusSnapshot } from "./contract";
export type { StatusSnapshot } from "./contract";
export { createLiveStatusProvider, emptyLiveSnapshot } from "./live/provider";
export type { LiveStatusOptions } from "./live/provider";
export {
  fakeStatusProvider,
  handleStatusRequest,
  providerFor,
  startStatusServer,
  statusResponse,
} from "./server/handler";
export type { StatusProvider } from "./server/handler";
