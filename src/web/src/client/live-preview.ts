import type { StatusLivePreview } from "../contract";
import { esc } from "./format";

export function livePreviewPanel(preview: StatusLivePreview | undefined): string {
  if (!preview)
    return '<p role="status">The preview has stopped. Ask the agent to start it again.</p>';
  const confirmation =
    preview.confirmed === false
      ? '<p role="status">Waiting for the runner to reconnect. Accept is disabled until it confirms this preview.</p>'
      : "";
  const url = esc(preview.url);
  const checklist = `<ul>${preview.checklist.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  const open = `<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Open in new tab</a>`;
  if (!preview.frameable)
    return `<div data-live-preview="${preview.expiresAt}" data-preview-url="${url}"><p>This app does not allow framing. Try it in a new tab, then return here to Accept or request changes.</p>${open}<h3>Things to check</h3>${checklist}${confirmation}</div>`;
  return `<div data-live-preview="${preview.expiresAt}" data-preview-url="${url}" class="min-w-0"><div class="row wrap" role="group" aria-label="Preview viewport"><button class="btn" type="button" data-preview-width="100%" aria-pressed="true">Desktop</button><button class="btn" type="button" data-preview-width="768px" aria-pressed="false">Tablet</button><button class="btn" type="button" data-preview-width="390px" aria-pressed="false">Phone</button><button class="btn" type="button" data-preview-reload>Reload</button>${open}</div><div class="live-preview-layout"><div class="live-preview-stage"><iframe title="Live product preview" src="${url}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads" referrerpolicy="no-referrer" class="live-preview-frame"></iframe></div><div><h3>Things to check</h3>${checklist}<p class="muted">The preview stops after one hour. Use a new tab if the app cannot load here.</p></div></div>${confirmation}</div>`;
}
