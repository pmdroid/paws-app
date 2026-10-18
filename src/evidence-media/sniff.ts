import type { EvidenceMediaType } from "../db";

/** Bytes read from the start of a file to decide its type. */
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
  "mmp4",
  "M4V ",
]);

/**
 * The media type of a file from its leading bytes, never its name.
 * Returns null for anything other than WebM, MP4, PNG, JPEG and WebP, which includes SVG.
 */
export function sniffMediaType(head: Uint8Array): EvidenceMediaType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) && ebmlDocType(head) === "webm")
    return "video/webm";
  if (ascii(head, 4, 8) === "ftyp" && mp4Brand(head)) return "video/mp4";
  return null;
}

export function isVideo(type: EvidenceMediaType): boolean {
  return type.startsWith("video/");
}

function startsWith(head: Uint8Array, prefix: readonly number[]): boolean {
  return head.length >= prefix.length && prefix.every((byte, index) => head[index] === byte);
}

function ascii(head: Uint8Array, start: number, end: number): string | null {
  if (head.length < end) return null;
  return String.fromCharCode(...head.subarray(start, end));
}

/** DocType (element 0x4282) inside the EBML header that follows the 4-byte magic. */
function ebmlDocType(head: Uint8Array): string | null {
  for (let index = 4; index + 2 < head.length; index++) {
    if (head[index] !== 0x42 || head[index + 1] !== 0x82) continue;
    const size = vint(head, index + 2);
    if (size === null) return null;
    const start = index + 2 + size.width;
    return ascii(head, start, start + size.value);
  }
  return null;
}

function vint(head: Uint8Array, offset: number): { width: number; value: number } | null {
  const first = head[offset];
  if (first === undefined || first === 0) return null;
  let width = 1;
  while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width++;
  if (offset + width > head.length) return null;
  let value = first & (0xff >> width);
  for (let index = 1; index < width; index++) value = value * 256 + head[offset + index]!;
  return { width, value };
}

/** Major brand or one of the compatible brands in the leading `ftyp` box. */
function mp4Brand(head: Uint8Array): boolean {
  const boxSize = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  const end = Math.min(boxSize, head.length);
  if (end < 16) return false;
  if (MP4_BRANDS.has(ascii(head, 8, 12)!)) return true;
  for (let index = 16; index + 4 <= end; index += 4)
    if (MP4_BRANDS.has(ascii(head, index, index + 4)!)) return true;
  return false;
}
