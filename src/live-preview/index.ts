import { LIVE_PREVIEW_RUNNER_VERSION } from "../runner-protocol";
import type { PreviewRequest, PreviewReady } from "../runner-protocol";
export {
  PreviewRequestSchema,
  PreviewReadySchema,
  type PreviewRequest,
  type PreviewReady,
} from "../runner-protocol";

export interface ShowPreviewHook {
  show(request: PreviewRequest, context: { signal: AbortSignal }): Promise<string>;
}
export interface ReviewPreviewHook {
  review(preview: PreviewReady, context: { signal: AbortSignal }): Promise<string>;
  stopped?(id: string): void;
}
export { runPreview, type PreviewRuntime, type PreviewProcess } from "./runtime";
export { createFakePreviewRuntime } from "./fake";

export function previewRunnerSupported(version: string | null | undefined): boolean {
  const parts = version
    ?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (const [index, minimum] of LIVE_PREVIEW_RUNNER_VERSION.entries()) {
    if (parts[index] !== minimum) return parts[index]! > minimum;
  }
  return true;
}
