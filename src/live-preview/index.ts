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
