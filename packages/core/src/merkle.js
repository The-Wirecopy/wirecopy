/**
 * Canonical Finding Leaf & Sorted-Pair Keccak-256 Merkle Tape Tree.
 *
 * Matches `WireTapeRegistry.sol` byte-for-byte:
 *  - Leaf hash: keccak256(utf8("wirecopy:finding:v1:" + canonicalJson(record)))
 *  - Internal node: keccak256(abi.encodePacked(min(a, b), max(a, b)))
 */

import { keccak256, hexToBytes } from "./keccak.js";

export const WIRE_LEAF_PREFIX = "wirecopy:finding:v1:";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function normalizeFindingLeaf(raw) {
  return {
    epochHour: Number(raw.epochHour),
    chainId: Number(raw.chainId ?? 4663),
    findingId: Number(raw.findingId ?? raw.id ?? 0),
    dispatchId: Number(raw.dispatchId ?? raw.mission ?? 0),
    desk: String(raw.desk ?? raw.agent ?? "equities").toLowerCase(),
    claim: String(raw.claim || "").trim(),
    evidence: String(raw.evidence || "").trim(),
    sourceUrl: String(raw.sourceUrl ?? raw.source ?? "").trim(),
    status: String(raw.status || "verified").toLowerCase(),
  };
}

export function hashFindingLeaf(record) {
  const normalized = normalizeFindingLeaf(record);
  const canonical = WIRE_LEAF_PREFIX + canonicalJson(normalized);
  return {
    normalized,
    canonical,
    leafHash: keccak256(canonical),
  };
}

export function hashSortedPair(hexA, hexB) {
  const a = hexA.toLowerCase();
  const b = hexB.toLowerCase();
  const [first, second] = a <= b ? [a, b] : [b, a];
  const bytesA = hexToBytes(first);
  const bytesB = hexToBytes(second);
  const combined = new Uint8Array(64);
  combined.set(bytesA, 0);
  combined.set(bytesB, 32);
  return keccak256(combined);
}

export function buildMerkleTree(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("buildMerkleTree requires at least 1 finding leaf");
  }

  const prepared = items.map((item, idx) => {
    if (typeof item === "string" && /^0x[0-9a-fA-F]{64}$/.test(item)) {
      return { index: idx, leafHash: item.toLowerCase(), normalized: null, canonical: null };
    }
    const h = hashFindingLeaf(item);
    return { index: idx, ...h, leafHash: h.leafHash.toLowerCase() };
  });

  const layers = [prepared.map((p) => p.leafHash)];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i];
      const right = i + 1 < cur.length ? cur[i + 1] : cur[i];
      next.push(hashSortedPair(left, right));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];

  function getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= prepared.length) {
      throw new RangeError(`Leaf index out of range: ${leafIndex}`);
    }
    const proof = [];
    let idx = leafIndex;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const pairIdx = idx % 2 === 0 ? (idx + 1 < layer.length ? idx + 1 : idx) : idx - 1;
      proof.push(layer[pairIdx]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return {
    root,
    leaves: prepared,
    layers,
    getProof,
  };
}

export function verifyMerkleProof({ record, leafHash, proof, expectedRoot }) {
  const computedLeaf = leafHash
    ? leafHash.toLowerCase()
    : hashFindingLeaf(record).leafHash.toLowerCase();

  let acc = computedLeaf;
  for (const sibling of proof || []) {
    acc = hashSortedPair(acc, sibling);
  }
  const normRoot = String(expectedRoot || "").toLowerCase();
  return {
    valid: acc === normRoot,
    computedLeaf,
    computedRoot: acc,
    expectedRoot: normRoot,
  };
}
