const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 26-character ULID. Time prefix plus 80 bits of randomness. */
export function ulid(now = Date.now()): string {
  let time = now;
  let prefix = "";
  for (let index = 0; index < 10; index++) {
    prefix = ENCODING[time % 32]! + prefix;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let random = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ENCODING[(value >>> bits) & 31]!;
    }
  }
  return prefix + random;
}
