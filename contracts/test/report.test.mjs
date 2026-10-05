import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createChain } from "../chain.mjs";
import { leafOf, rootFromProof } from "../leaf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "web", "public", "data", "findings.json"), "utf8"));
const artifact = JSON.parse(fs.readFileSync(path.join(here, "..", "out", "CreditClaimRegistry.json"), "utf8"));

test("every published finding hashes to its stored leaf and proves into the report root", () => {
  assert.ok(report.findings.length > 0);
  for (const f of report.findings) {
    assert.equal(leafOf(f), f.leaf, f.id);
    assert.equal(rootFromProof(f.leaf, f.proof), report.summary.merkle_root, f.id);
  }
});

test("the report root anchored on-chain verifies published findings", async () => {
  const chain = await createChain();
  const { owner, auditor } = chain.accounts;
  const reg = await chain.deploy(artifact, owner);
  await reg.send(owner, "setAuditor", [auditor.hex, true]);
  assert.equal((await reg.send(auditor, "anchorReport", [report.summary.merkle_root, "findings.json"])).ok, true);
  for (const f of report.findings.slice(0, 5)) {
    assert.equal(await reg.call("verifyFinding", [0n, f.leaf, f.proof]), true, f.id);
  }
});

test("published overlap figures match the listings' vintage data", () => {
  for (const f of report.findings) {
    const a = f.listing_a.issued_by_vintage, b = f.listing_b.issued_by_vintage;
    const shared = Object.keys(a).filter((y) => a[y] > 0 && b[y] > 0).map(Number).sort();
    assert.deepEqual(shared, [...f.overlap_vintages].sort(), f.id);
    const vol = shared.reduce((s, y) => s + Math.min(a[y], b[y]), 0);
    assert.ok(Math.abs(vol - f.overlap_volume) <= shared.length, f.id);
  }
});
