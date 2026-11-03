/**
 * In-module barrel for dashboard tests. Other modules import `src/dashboard` only.
 *
 * Call `handleStatusRequest` from the engine HTTP server. Return value `null`
 * means the request is not a dashboard route (leave webhooks and everything else
 * alone). The resource routes read `createLiveStatusProvider(db)` (`source: "live"`).
 */
export { createLiveStatusProvider } from "./live/provider";
export type { LiveStatusOptions } from "./live/provider";
export {
  fakeStatusProvider,
  handleStatusRequest,
  providerFor,
  startStatusServer,
  statusResponse,
} from "./server/handler";
export type { StatusProvider } from "./server/handler";
