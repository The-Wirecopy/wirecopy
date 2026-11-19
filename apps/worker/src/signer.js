/**
 * Zero-dependency secp256k1 + EIP-155 legacy transaction signer for Cloudflare Workers & Node.
 * Used exclusively by the server's `SEAL_SIGNER_KEY` to commit hourly Merkle tape roots to
 * `WireTapeRegistry.sealTape(...)` on Robinhood Chain (chainId = 4663).
 */

import { keccak256Bytes, hexToBytes, bytesToHex } from "../../../packages/core/src/keccak.js";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = P) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function modInv(a, m = P) {
  let [lm, hm] = [1n, 0n];
  let [low, high] = [mod(a, m), m];
  while (low > 1n) {
    const ratio = high / low;
    [lm, hm] = [hm - lm * ratio, lm];
    [low, high] = [high - low * ratio, low];
  }
  return mod(lm, m);
}

function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && y1 !== y2) return null;
  const lam = x1 === x2 ? mod(3n * x1 * x1 * modInv(2n * y1)) : mod((y2 - y1) * modInv(x2 - x1));
  const x3 = mod(lam * lam - x1 - x2);
  const y3 = mod(lam * (x1 - x3) - y1);
  return [x3, y3];
}

function pointMul(k, pt = [GX, GY]) {
  let n = mod(k, N);
  let cur = pt;
  let res = null;
  while (n > 0n) {
    if (n & 1n) res = pointAdd(res, cur);
    cur = pointAdd(cur, cur);
    n >>= 1n;
  }
  return res;
}

export function privateKeyToAddress(privHex) {
  const d = BigInt(privHex.startsWith("0x") ? privHex : "0x" + privHex);
  const [x, y] = pointMul(d);
  const pub = new Uint8Array(64);
  pub.set(hexToBytes(x.toString(16).padStart(64, "0")), 0);
  pub.set(hexToBytes(y.toString(16).padStart(64, "0")), 32);
  return bytesToHex(keccak256Bytes(pub).slice(12)).toLowerCase();
}

function signDigest(msgHashBytes, privHex) {
  const d = BigInt(privHex.startsWith("0x") ? privHex : "0x" + privHex);
  const z = BigInt(bytesToHex(msgHashBytes));
  const privBytes = hexToBytes(d.toString(16).padStart(64, "0"));
  for (let ctr = 0; ctr < 32; ctr++) {
    const seed = new Uint8Array(65);
    seed.set(privBytes, 0);
    seed.set(msgHashBytes, 32);
    seed[64] = ctr;
    const k = mod(BigInt(bytesToHex(keccak256Bytes(seed))), N);
    if (k === 0n) continue;
    const pt = pointMul(k);
    if (!pt) continue;
    const r = mod(pt[0], N);
    if (r === 0n) continue;
    let s = mod(modInv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    let yParity = Number(pt[1] & 1n);
    if (s > N / 2n) {
      s = N - s;
      yParity ^= 1;
    }
    return { r, s, yParity };
  }
  throw new Error("Failed to sign digest");
}

function bigintToMinBytes(bi) {
  const n = BigInt(bi);
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return hexToBytes(hex);
}

function rlpEncode(item) {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    if (item.length <= 55) {
      const out = new Uint8Array(1 + item.length);
      out[0] = 0x80 + item.length;
      out.set(item, 1);
      return out;
    }
    const lenBytes = bigintToMinBytes(item.length);
    const out = new Uint8Array(1 + lenBytes.length + item.length);
    out[0] = 0xb7 + lenBytes.length;
    out.set(lenBytes, 1);
    out.set(item, 1 + lenBytes.length);
    return out;
  }
  if (Array.isArray(item)) {
    const parts = item.map((x) => rlpEncode(x));
    const total = parts.reduce((s, p) => s + p.length, 0);
    if (total <= 55) {
      const out = new Uint8Array(1 + total);
      out[0] = 0xc0 + total;
      let off = 1;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    }
    const lenBytes = bigintToMinBytes(total);
    const out = new Uint8Array(1 + lenBytes.length + total);
    out[0] = 0xf7 + lenBytes.length;
    out.set(lenBytes, 1);
    let off = 1 + lenBytes.length;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  throw new TypeError("RLP item must be Uint8Array or Array");
}

export function signLegacyTx({ nonce, gasPriceWei, gasLimit, to, valueWei = 0n, dataHex = "0x", chainId = 4663 }, privHex) {
  const unsignedFields = [
    bigintToMinBytes(nonce),
    bigintToMinBytes(gasPriceWei),
    bigintToMinBytes(gasLimit),
    hexToBytes(to),
    bigintToMinBytes(valueWei),
    hexToBytes(dataHex),
    bigintToMinBytes(chainId),
    new Uint8Array(0),
    new Uint8Array(0),
  ];
  const sighash = keccak256Bytes(rlpEncode(unsignedFields));
  const { r, s, yParity } = signDigest(sighash, privHex);
  const v = BigInt(chainId) * 2n + 35n + BigInt(yParity);

  const signedFields = [
    bigintToMinBytes(nonce),
    bigintToMinBytes(gasPriceWei),
    bigintToMinBytes(gasLimit),
    hexToBytes(to),
    bigintToMinBytes(valueWei),
    hexToBytes(dataHex),
    bigintToMinBytes(v),
    bigintToMinBytes(r),
    bigintToMinBytes(s),
  ];
  const rawBytes = rlpEncode(signedFields);
  return {
    rawTx: bytesToHex(rawBytes),
    txHash: bytesToHex(keccak256Bytes(rawBytes)),
  };
}
