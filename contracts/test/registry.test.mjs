import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { keccak256, stringToHex } from "viem";
import { code8, createChain, key, merkle } from "../chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(fs.readFileSync(path.join(here, "..", "out", "CreditClaimRegistry.json"), "utf8"));

async function setup() {
  const chain = await createChain();
  const { owner, auditor, verra, goldstandard } = chain.accounts;
  const reg = await chain.deploy(artifact, owner);
  assert.ok((await reg.send(owner, "addRegistry", [verra.hex, code8("VCS")])).ok);
  assert.ok((await reg.send(owner, "addRegistry", [goldstandard.hex, code8("GOLD")])).ok);
  assert.ok((await reg.send(owner, "setAuditor", [auditor.hex, true])).ok);
  return { chain, reg, ...chain.accounts };
}

const serial = (s) => keccak256(stringToHex(s));

test("a registry records issuances for its own listing", async () => {
  const { reg, verra } = await setup();
  const r = await reg.send(verra, "recordIssuance", [key("VCS1931"), 2019, 600000n, serial("VCS-2019-batch-1")]);
  assert.equal(r.ok, true);
  assert.equal(r.events[0].name, "IssuanceRecorded");
  assert.equal(await reg.call("vintageIssuer", [key("VCS1931"), 2019]), code8("VCS"));
});

test("only registries can record and only auditors can link", async () => {
  const { reg, outsider } = await setup();
  const r1 = await reg.send(outsider, "recordIssuance", [key("X1"), 2020, 1n, serial("x")]);
  assert.equal(r1.ok, false);
  assert.equal(r1.error.name, "NotRegistry");
  const r2 = await reg.send(outsider, "linkListings", [key("A"), key("B"), 9000, serial("e")]);
  assert.equal(r2.error.name, "NotAuditor");
});

test("linking two listings reports vintages both registries already issued", async () => {
  const { reg, verra, goldstandard, auditor } = await setup();
  for (const v of [2018, 2019, 2020, 2021]) await reg.send(verra, "recordIssuance", [key("VCS1931"), v, 500000n, serial(`V${v}`)]);
  for (const v of [2019, 2020, 2021, 2022]) await reg.send(goldstandard, "recordIssuance", [key("GS7538"), v, 400000n, serial(`G${v}`)]);
  const r = await reg.send(auditor, "linkListings", [key("VCS1931"), key("GS7538"), 9500, serial("evidence")]);
  assert.equal(r.ok, true);
  const conflicts = r.events.filter((e) => e.name === "ConflictDetected").map((e) => e.args.vintage);
  assert.deepEqual(conflicts, [2019, 2020, 2021]);
  assert.equal(await reg.call("assetKey", [key("GS7538")]), key("VCS1931"));
  // Gold Standard's 2022 vintage is merged into the shared asset.
  assert.equal(await reg.call("vintageIssuer", [key("VCS1931"), 2022]), code8("GOLD"));
});

test("after a link, a second registry cannot issue an already-issued vintage", async () => {
  const { reg, verra, goldstandard, auditor } = await setup();
  await reg.send(verra, "recordIssuance", [key("VCS1931"), 2023, 300000n, serial("V2023")]);
  await reg.send(auditor, "linkListings", [key("VCS1931"), key("GS7538"), 9500, serial("evidence")]);
  const blocked = await reg.send(goldstandard, "recordIssuance", [key("GS7538"), 2023, 300000n, serial("G2023")]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.name, "DoubleIssuance");
  assert.equal(blocked.error.args[1], 2023);
  // The original registry may keep issuing further batches for that vintage.
  const again = await reg.send(verra, "recordIssuance", [key("VCS1931"), 2023, 1000n, serial("V2023-b")]);
  assert.equal(again.ok, true);
  // A new vintage is open to whichever registry claims it first.
  const fresh = await reg.send(goldstandard, "recordIssuance", [key("GS7538"), 2024, 1000n, serial("G2024")]);
  assert.equal(fresh.ok, true);
});

test("the same batch cannot be recorded twice", async () => {
  const { reg, verra } = await setup();
  const args = [key("VCS1931"), 2019, 10n, serial("batch")];
  assert.equal((await reg.send(verra, "recordIssuance", args)).ok, true);
  const dup = await reg.send(verra, "recordIssuance", args);
  assert.equal(dup.error.name, "DuplicateIssuance");
});

test("retirement cannot exceed what is left", async () => {
  const { reg, verra, goldstandard } = await setup();
  const r = await reg.send(verra, "recordIssuance", [key("VCS1931"), 2019, 100n, serial("b")]);
  const id = r.events[0].args.id;
  assert.equal((await reg.send(verra, "retire", [id, 60n, serial("buyer-1")])).ok, true);
  const over = await reg.send(verra, "retire", [id, 50n, serial("buyer-2")]);
  assert.equal(over.error.name, "OverRetirement");
  assert.equal(over.error.args[1], 40n);
  const foreign = await reg.send(goldstandard, "retire", [id, 1n, serial("buyer-3")]);
  assert.equal(foreign.error.name, "NotIssuer");
});

test("a listing that is already linked cannot be linked again", async () => {
  const { reg, auditor } = await setup();
  await reg.send(auditor, "linkListings", [key("A"), key("B"), 9000, serial("e1")]);
  const again = await reg.send(auditor, "linkListings", [key("C"), key("B"), 9000, serial("e2")]);
  assert.equal(again.error.name, "AlreadyLinked");
  const root = await reg.send(auditor, "linkListings", [key("C"), key("A"), 9000, serial("e3")]);
  assert.equal(root.error.name, "AlreadyLinked");
});

test("anchored report proofs verify, tampered findings do not", async () => {
  const { reg, auditor } = await setup();
  const leaves = ["f1", "f2", "f3", "f4", "f5"].map((s) => keccak256(stringToHex(s)));
  const tree = merkle(leaves);
  const r = await reg.send(auditor, "anchorReport", [tree.root, "ipfs://example-report"]);
  assert.equal(r.ok, true);
  for (let i = 0; i < leaves.length; i++) {
    assert.equal(await reg.call("verifyFinding", [0n, leaves[i], tree.proof(i)]), true);
  }
  assert.equal(await reg.call("verifyFinding", [0n, keccak256(stringToHex("forged")), tree.proof(0)]), false);
});
