import { LIVE_PREVIEW_RUNNER_VERSION, runnerVersionAtLeast } from "../runner-protocol";
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
  /** Require a preview-capable runner for this resumed implementation. */
  required?: boolean;
  review(preview: PreviewReady, context: { signal: AbortSignal }): Promise<string>;
  stopped?(id: string): void;
}
export { runPreview, type PreviewRuntime, type PreviewProcess } from "./runtime";
export { createFakePreviewRuntime } from "./fake";

export function previewRunnerSupported(version: string | null | undefined): boolean {
  return runnerVersionAtLeast(version ?? "", LIVE_PREVIEW_RUNNER_VERSION);
}
