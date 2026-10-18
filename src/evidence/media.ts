import type { EvidenceMediaType } from "../db";

/** Per-file caps. A video may be longer than a screenshot is large. */
export type EvidenceCaps = { video: number; image: number };

export const EVIDENCE_CAPS: EvidenceCaps = {
  video: 200 * 1024 * 1024,
  image: 20 * 1024 * 1024,
};

/** ISO base media major brands that browsers play as MP4. QuickTime, HEIF and AVIF are not here. */
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

/**
 * The media type the bytes start with, or null. Only the content counts: a
 * file name or a declared type is never consulted, so SVG, HTML and anything
 * else without one of these signatures is refused.
 */
export function sniffEvidence(bytes: Uint8Array): EvidenceMediaType | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp" && MP4_BRANDS.has(ascii(bytes, 8, 12))) return "video/mp4";
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && ebmlDocType(bytes) === "webm") return "video/webm";
  return null;
}

export function evidenceCap(type: EvidenceMediaType, caps: EvidenceCaps): number {
  return type.startsWith("video/") ? caps.video : caps.image;
}

function starts(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  if (bytes.length < to) return "";
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** Matroska and WebM share the EBML magic. The DocType element (0x4282) tells them apart. */
function ebmlDocType(bytes: Uint8Array): string | null {
  const end = Math.min(bytes.length, 64);
  for (let index = 4; index + 2 < end; index++) {
    if (bytes[index] !== 0x42 || bytes[index + 1] !== 0x82) continue;
    const size = bytes[index + 2] ?? 0;
    if ((size & 0x80) === 0) return null;
    const length = size & 0x7f;
    return ascii(bytes, index + 3, index + 3 + length) || null;
  }
  return null;
}
