import type { AcpEvent } from "../acp";

const maxEventBytes = 200_000;

function compactValue(value: unknown, stringLimit: number): unknown {
  if (typeof value === "string") {
    return value.length > stringLimit
      ? `${value.slice(0, stringLimit)} [${value.length - stringLimit} characters omitted]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (isByteArray(value)) return compactValue(Buffer.from(value).toString("utf8"), stringLimit);
  if (Array.isArray(value)) return value.map((entry) => compactValue(entry, stringLimit));
  const record = value as Record<string, unknown>;
  if (record.type === "image") {
    const source = record.source as Record<string, unknown> | undefined;
    const mimeType = record.mimeType ?? source?.media_type ?? "unknown";
    return { type: "text", text: `[${mimeType} image omitted]` };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, compactValue(entry, stringLimit)]),
  );
}

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 16 &&
    value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  );
}

export function compactAcpEvent(event: AcpEvent): AcpEvent {
  const withoutImages = compactValue(event, Infinity) as AcpEvent;
  if (Buffer.byteLength(JSON.stringify(withoutImages)) <= maxEventBytes) return withoutImages;
  const shortened = compactValue(withoutImages, 16_384) as AcpEvent;
  if (Buffer.byteLength(JSON.stringify(shortened)) <= maxEventBytes) return shortened;
  return { type: "progress", text: "Oversized ACP event omitted from the runner journal." };
}
