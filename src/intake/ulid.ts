const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-character ULID. Time prefix plus 80 bits of randomness. */
export function ulid(now = Date.now()): string {
  let time = now;
  const chars: string[] = new Array<string>(10);
  for (let index = 9; index >= 0; index--) {
    chars[index] = encode(time % 32);
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let random = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += encode((value >>> bits) & 31);
    }
  }
  return chars.join("") + random;
}

function encode(index: number): string {
  const char = ENCODING[index];
  if (char === undefined) throw new Error("ulid index out of range");
  return char;
}
