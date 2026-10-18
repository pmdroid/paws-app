import type { EvidenceMediaType } from "../db";

export const SNIFF_BYTES = 64;

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
]);

export function sniffMedia(head: Uint8Array): EvidenceMediaType | null {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  if (ascii(head, 4, 4) === "ftyp" && MP4_BRANDS.has(ascii(head, 8, 4))) return "video/mp4";
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3]) && ebmlDocType(head) === "webm") return "video/webm";
  return null;
}

export function mediaKind(type: EvidenceMediaType): "video" | "image" {
  return type.startsWith("video/") ? "video" : "image";
}

function starts(head: Uint8Array, magic: readonly number[]): boolean {
  return head.length >= magic.length && magic.every((byte, index) => head[index] === byte);
}

function ascii(head: Uint8Array, offset: number, length: number): string {
  if (head.length < offset + length) return "";
  return String.fromCharCode(...head.subarray(offset, offset + length));
}

function ebmlDocType(head: Uint8Array): string | null {
  for (let index = 4; index + 2 < head.length; index++) {
    if (head[index] !== 0x42 || head[index + 1] !== 0x82) continue;
    const first = head[index + 2]!;
    let width = 1;
    while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width++;
    if (width > 8 || index + 2 + width > head.length) return null;
    let size = first & (0xff >> width);
    for (let byte = 1; byte < width; byte++) size = size * 256 + head[index + 2 + byte]!;
    const start = index + 2 + width;
    return ascii(head, start, size) || null;
  }
  return null;
}
