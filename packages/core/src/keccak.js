/**
 * Pure zero-dependency Keccak-256 (Ethereum 0x01 padding).
 * Identical across Browser, Cloudflare Workers, and Node >=20 CLI.
 */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(state) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let i = 0; i < 5; i++) {
      bc[i] = state[i] ^ state[i + 5] ^ state[i + 10] ^ state[i + 15] ^ state[i + 20];
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) {
        state[j + i] = (state[j + i] ^ t) & MASK64;
      }
    }
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = state[j];
      state[j] = rotl64(t, ROTC[i]);
      t = tmp;
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = state[j + i];
      for (let i = 0; i < 5; i++) {
        state[j + i] = (state[j + i] ^ ((~bc[(i + 1) % 5] & MASK64) & bc[(i + 2) % 5])) & MASK64;
      }
    }
    state[0] = (state[0] ^ RC[round]) & MASK64;
  }
}

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length: ${clean.length}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

export function keccak256Bytes(input, { asHex = false } = {}) {
  let msg;
  if (input instanceof Uint8Array) {
    msg = input;
  } else if (typeof input === "string") {
    msg = asHex ? hexToBytes(input) : utf8ToBytes(input);
  } else {
    throw new TypeError("keccak256 input must be Uint8Array or string");
  }

  const rate = 136;
  const state = new Array(25).fill(0n);
  const paddedLen = Math.ceil((msg.length + 1) / rate) * rate;
  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[msg.length] ^= 0x01;
  buf[paddedLen - 1] ^= 0x80;

  for (let offset = 0; offset < paddedLen; offset += rate) {
    for (let i = 0; i < 17; i++) {
      let lane = 0n;
      const base = offset + i * 8;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(buf[base + b]) << BigInt(b * 8);
      }
      state[i] = (state[i] ^ lane) & MASK64;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const lane = state[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number((lane >> BigInt(b * 8)) & 0xffn);
    }
  }
  return out;
}

export function keccak256(input, opts = {}) {
  return bytesToHex(keccak256Bytes(input, opts));
}

export function keccak256Hex(hexInput) {
  return keccak256(hexInput, { asHex: true });
}
