// Stage 4: hash every finding into a Merkle tree whose root can be anchored on-chain with
// CreditClaimRegistry.anchorReport, and store each finding's leaf and proof for the dashboard.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merkle } from "../contracts/chain.mjs";
import { leafOf, rootFromProof } from "../contracts/leaf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "web", "public", "data", "findings.json");
const doc = JSON.parse(fs.readFileSync(file, "utf8"));

const leaves = doc.findings.map(leafOf);
const tree = merkle(leaves);
doc.findings.forEach((f, i) => {
  f.leaf = leaves[i];
  f.proof = tree.proof(i);
});
doc.summary.merkle_root = tree.root;
if (!doc.findings.every((f) => rootFromProof(f.leaf, f.proof) === tree.root)) throw new Error("proof self-check failed");
doc.summary.leaf_encoding = "keccak256(abi.encode(string id, bytes32 keccak(a), bytes32 keccak(b), uint16[] vintages, uint256 overlapVolume, string verdict))";
fs.writeFileSync(file, JSON.stringify(doc, null, 1));
console.log(`anchored ${leaves.length} findings, root ${tree.root}`);
