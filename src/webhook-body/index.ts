const MAX_READERS = 4;
let reading = 0;

export async function readWebhookBody(
  request: Request,
  maxBytes: number,
  timeoutMs = 5_000,
): Promise<Buffer | Response> {
  const reject = (status: number, message: string) => {
    void request.body?.cancel().catch(() => undefined);
    return new Response(message, { status, headers: { "cache-control": "no-store" } });
  };
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) return reject(400, "Invalid webhook body length.");
    if (Number(length) > maxBytes) return reject(413, "Webhook body is too large.");
  }
  if (reading >= MAX_READERS) return reject(503, "Webhook intake is busy. Retry shortly.");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  reading++;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([request.signal, deadline]);
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > maxBytes) return new Response("Webhook body is too large.", { status: 413 });
      chunks.push(next.value);
    }
  } catch {
    return new Response("Webhook body could not be read.", { status: signal.aborted ? 408 : 400 });
  } finally {
    reading--;
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
