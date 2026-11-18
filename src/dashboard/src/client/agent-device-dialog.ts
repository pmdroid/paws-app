import { esc } from "./format";
import { renderMarkup } from "./theme";

type Device = { userCode: string; verificationUri: string; interval: number; expiresAt: number };
type Status = { state: "pending" | "signed-in" | "denied" | "expired" };

export function openAgentDeviceDialog(
  name: string,
  provider: string,
  label: string,
  request: <T>(method: string) => Promise<T>,
  onClose: () => void,
): void {
  const host = document.createElement("div");
  document.body.append(host);
  renderMarkup(
    host,
    `<dialog aria-labelledby="agent-device-heading"><div class="dialog-body col"><div class="between"><h2 id="agent-device-heading">Sign in to ${esc(name)} for ${esc(label)}</h2><button class="btn" data-device-close>Close</button></div><div data-device-challenge class="col" hidden><strong class="text-3xl break-all" data-device-code></strong><button class="btn" data-device-copy>Copy code</button><a class="btn primary" data-device-link target="_blank" rel="noopener noreferrer">Open ${esc(provider)} sign-in</a></div><p role="status" aria-live="polite" data-device-status>Starting sign-in…</p><button class="btn" data-device-retry hidden>Retry</button></div></dialog>`,
  );
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const status = host.querySelector<HTMLElement>("[data-device-status]")!;
  const challenge = host.querySelector<HTMLElement>("[data-device-challenge]")!;
  const retry = host.querySelector<HTMLButtonElement>("[data-device-retry]")!;
  const copy = host.querySelector<HTMLButtonElement>("[data-device-copy]")!;
  let device: Device | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    host.remove();
    onClose();
  };
  const fail = (message: string) => {
    status.textContent = message;
    challenge.hidden = true;
    retry.hidden = false;
  };
  const waiting = () => {
    status.textContent = `Waiting for you to approve… expires in ${Math.max(0, Math.ceil((device!.expiresAt - Date.now()) / 60000))} min`;
  };
  const poll = async () => {
    if (closed) return;
    try {
      const result = await request<Status>("GET");
      if (closed) return;
      if (result.state === "signed-in") {
        status.textContent = "Signed in";
        challenge.hidden = true;
        timer = setTimeout(close, 1000);
      } else if (result.state === "pending" && device!.expiresAt > Date.now()) {
        waiting();
        timer = setTimeout(() => void poll(), device!.interval * 1000);
      } else
        fail(
          result.state === "denied" ? "Sign-in denied. Try again." : "Sign-in expired. Try again.",
        );
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error.message : "Sign-in failed. Try again.");
    }
  };
  const start = async () => {
    clearTimeout(timer);
    retry.hidden = true;
    challenge.hidden = true;
    status.textContent = "Starting sign-in…";
    try {
      device = await request<Device>("POST");
      if (closed) return;
      const url = new URL(device.verificationUri);
      if (url.protocol !== "https:") throw new Error("Sign-in URL must use HTTPS. Try again.");
      host.querySelector<HTMLElement>("[data-device-code]")!.textContent = device.userCode;
      host.querySelector<HTMLAnchorElement>("[data-device-link]")!.href = url.href;
      copy.textContent = "Copy code";
      challenge.hidden = false;
      waiting();
      timer = setTimeout(() => void poll(), device.interval * 1000);
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error.message : "Sign-in failed. Try again.");
    }
  };
  copy.onclick = async () => {
    try {
      await window.navigator.clipboard.writeText(device!.userCode);
      copy.textContent = "Copied";
    } catch {
      status.textContent = "Could not copy. Select the code and copy it.";
    }
  };
  retry.onclick = () => void start();
  host.querySelector<HTMLButtonElement>("[data-device-close]")!.onclick = close;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", close);
  dialog.showModal();
  void start();
}
