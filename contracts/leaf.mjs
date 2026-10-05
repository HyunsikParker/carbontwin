// Leaf encoding for report findings, shared by the anchoring script and the dashboard.
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";

export function leafOf(f) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, bytes32, bytes32, uint16[], uint256, string"), [
      f.id,
      keccak256(stringToHex(f.a)),
      keccak256(stringToHex(f.b)),
      f.overlap_vintages,
      BigInt(f.overlap_volume),
      f.verdict,
    ]),
  );
}

/** Fold a sorted-pair proof, exactly as CreditClaimRegistry.verifyFinding does. */
export function rootFromProof(leaf, proof) {
  let h = leaf;
  for (const p of proof) h = h < p ? keccak256(`${h}${p.slice(2)}`) : keccak256(`${p}${h.slice(2)}`);
  return h;
}
