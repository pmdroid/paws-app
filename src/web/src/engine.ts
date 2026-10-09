/**
 * In-module barrel for status tests. Other modules import `src/web` only.
 *
 * Call `handleStatusRequest` from the engine HTTP server. Return value `null`
 * means the request is not a status route (leave webhooks and everything else
 * alone). Replace `fakeStatusProvider` with a reader over the engine's own
 * state when that exists; until then the stub serves the sample snapshot
 * (`source: "demo"`).
 */
export { STATUS_API_PATH, STATUS_PAGE_PATH, parseStatusSnapshot } from "./contract";
export type { StatusSnapshot } from "./contract";
export { demoStatus } from "./demo";
export {
  fakeStatusProvider,
  handleStatusRequest,
  startStatusServer,
  statusResponse,
} from "./server/handler";
export type { StatusProvider } from "./server/handler";
