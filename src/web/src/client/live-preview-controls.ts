export function clickLivePreview(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest<HTMLButtonElement>("[data-preview-width],[data-preview-reload]");
  const panel = button?.closest("[data-live-preview]");
  const frame = panel?.querySelector<HTMLIFrameElement>("iframe");
  if (!button || !frame || !panel) return false;
  if (button.hasAttribute("data-preview-reload")) frame.src = frame.getAttribute("src") ?? "";
  else {
    frame.style.width = button.dataset.previewWidth ?? "100%";
    for (const other of panel.querySelectorAll("[data-preview-width]"))
      other.setAttribute("aria-pressed", String(other === button));
  }
  event.preventDefault();
  return true;
}
