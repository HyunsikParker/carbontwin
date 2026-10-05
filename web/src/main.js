import { keccak256, stringToHex } from "viem";
import { code8, createChain, key } from "../../contracts/chain.mjs";
import { leafOf, rootFromProof } from "../../contracts/leaf.mjs";

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const REG_NAME = { VCS: "Verra (VCS)", GOLD: "Gold Standard", CAR: "Climate Action Reserve", ACR: "ACR", ISO: "Isometric", ART: "ART" };

let doc;
let selected = null;

async function main() {
  doc = await (await fetch("./data/findings.json")).json();
  renderStats(doc.summary);
  const pairs = [...new Set(doc.findings.map(pairLabel))].sort();
  $("#pair-filter").insertAdjacentHTML("beforeend", pairs.map((p) => `<option>${esc(p)}</option>`).join(""));
  $("#only-overlap").addEventListener("change", renderTable);
  $("#pair-filter").addEventListener("change", renderTable);
  $("#source").textContent = `${doc.summary.source}. Adjudicator: ${doc.summary.adjudicator}.`;
  $("#root").textContent = `Report Merkle root: ${doc.summary.merkle_root}  ·  leaf = ${doc.summary.leaf_encoding}`;
  renderTable();
  const first = visible()[0];
  if (first) select(first);
  wireDemo();
}

function pairLabel(f) {
  return [f.registry_a, f.registry_b].sort().join(" ↔ ");
}

function renderStats(s) {
  $("#s-projects").textContent = fmt(s.projects);
  const items = [
    [fmt(s.projects), "registry listings screened"],
    [fmt(s.candidates), "cross-registry candidate pairs"],
    [fmt(s.same_asset_with_overlap), "same-asset pairs with a shared vintage", true],
    [`${(s.overlap_volume / 1e6).toFixed(2)} M`, "tCO₂e issued for those shared vintages (smaller side)", true],
  ];
  $("#stats").innerHTML = items.map(([b, t, hot]) => `<div class="stat${hot ? " hot" : ""}"><b>${b}</b><span>${t}</span></div>`).join("");
}

function visible() {
  const only = $("#only-overlap").checked;
  const pair = $("#pair-filter").value;
  return doc.findings.filter((f) => (!only || f.overlap_vintages.length) && (!pair || pairLabel(f) === pair));
}

function renderTable() {
  const rows = visible();
  $("#table tbody").innerHTML = rows
    .map((f, i) => `
    <tr class="row${selected === f ? " active" : ""}" data-i="${doc.findings.indexOf(f)}" tabindex="0" aria-label="${esc(f.a)} and ${esc(f.b)}">
      <td><span class="chip ${f.registry_a}">${esc(f.a)}</span><span class="chip ${f.registry_b}">${esc(f.b)}</span>
          <span class="lname">${esc(f.listing_a["Project Name"])}</span></td>
      <td>${esc(f.country)}</td>
      <td>${f.overlap_vintages.join(", ") || "—"}</td>
      <td class="num">${fmt(f.overlap_volume)}</td>
      <td><span class="yes">same asset</span> <span class="small">${(f.shared_facts || []).length} checked facts</span></td>
      <td><button class="link">Details</button></td>
    </tr>`)
    .join("");
  for (const tr of document.querySelectorAll("#table tbody tr")) {
    tr.addEventListener("click", () => select(doc.findings[Number(tr.dataset.i)]));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(doc.findings[Number(tr.dataset.i)]); } });
  }
}

function select(f) {
  selected = f;
  renderTable();
  renderDetail(f);
  $("#demo-target").textContent = `Selected: ${f.a} (${REG_NAME[f.registry_a] ?? f.registry_a}) and ${f.b} (${REG_NAME[f.registry_b] ?? f.registry_b})`;
  resetDemo();
}

function card(L) {
  const rows = [
    ["Registry", REG_NAME[L["Voluntary Registry"]] ?? L["Voluntary Registry"]],
    ["Name", L["Project Name"]],
    ["Developer", L["Project Developer"]],
    ["Location", [L.Country, L.State, L["Project Site Location"]].filter((x) => x && x !== "None").join(" / ")],
    ["Type", `${L.Scope} / ${L.Type}`],
    ["Methodology", L["Methodology / Protocol"]],
    ["Status", L["Voluntary Status"]],
    ["Issued / retired", `${fmt(L["Total Credits Issued"])} / ${fmt(L["Total Credits Retired"])}`],
  ];
  if (L.notes) rows.push(["Notes", L.notes]);
  return `<div class="card"><span class="chip ${L["Voluntary Registry"]}">${esc(L["Project ID"])}</span>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>`;
}

function chart(f) {
  const a = f.listing_a.issued_by_vintage, b = f.listing_b.issued_by_vintage;
  const years = [...new Set([...Object.keys(a), ...Object.keys(b)])].map(Number).sort();
  if (!years.length) return "";
  const lo = years[0], hi = years[years.length - 1];
  const span = [];
  for (let y = lo; y <= hi; y++) span.push(y);
  const max = Math.max(...span.map((y) => Math.max(a[y] || 0, b[y] || 0)), 1);
  const W = 720, H = 170, pad = 28, bw = (W - pad * 2) / span.length;
  const bar = (y, v, i, side, color) => {
    const h = ((v || 0) / max) * (H - 50);
    const x = pad + i * bw + (side ? bw / 2 : 4);
    return `<rect x="${x.toFixed(1)}" y="${(H - 26 - h).toFixed(1)}" width="${(bw / 2 - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>${y}: ${fmt(v || 0)}</title></rect>`;
  };
  const colorOf = (r) => getComputedStyle(document.documentElement).getPropertyValue(`--${r === "GOLD" ? "gold" : r.toLowerCase()}`).trim() || "#888";
  let svg = "";
  span.forEach((y, i) => {
    if (f.overlap_vintages.includes(y)) svg += `<rect x="${(pad + i * bw).toFixed(1)}" y="8" width="${bw.toFixed(1)}" height="${H - 34}" fill="#f6e4dc"/>`;
    svg += bar(y, a[y], i, 0, colorOf(f.registry_a)) + bar(y, b[y], i, 1, colorOf(f.registry_b));
    svg += `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#5b6661">${String(y).slice(2)}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Credits issued by vintage for both listings">${svg}</svg>
    <div class="legend"><span><i style="background:${colorOf(f.registry_a)}"></i>${esc(f.a)}</span><span><i style="background:${colorOf(f.registry_b)}"></i>${esc(f.b)}</span><span><i style="background:#f6e4dc"></i>vintage issued by both</span></div></div>`;
}

function facts(f) {
  const rows = (f.shared_facts || []).map((x) => `<tr><td>${esc(x.field)}</td><td>${esc(x.value_a)}</td><td>${esc(x.value_b)}</td></tr>`).join("");
  const diffs = (f.differences || []).filter(Boolean);
  return `<table class="facts"><thead><tr><th>Shared fact (found in both records)</th><th>${esc(f.a)}</th><th>${esc(f.b)}</th></tr></thead><tbody>${rows}</tbody></table>
    ${diffs.length ? `<p class="diffs"><b>Differences the model noted:</b> ${diffs.map(esc).join("; ")}</p>` : ""}`;
}

function renderDetail(f) {
  const el = $("#detail");
  el.hidden = false;
  el.innerHTML = `
    <h3>${esc(f.a)} and ${esc(f.b)}</h3>
    ${chart(f)}
    <div class="reason"><b>Model verdict:</b> same asset in both passes${f.transfer_mentioned ? " · a registry transfer is mentioned" : ""}<br>${esc(f.reason)}</div>
    ${facts(f)}
    <div class="pair">${card(f.listing_a)}${card(f.listing_b)}</div>
    <div class="verify"><button class="link" id="verify-btn">Check this finding against the report root</button><span id="verify-out"></span></div>`;
  $("#verify-btn").addEventListener("click", () => {
    const leaf = leafOf(f);
    const ok = leaf === f.leaf && rootFromProof(leaf, f.proof) === doc.summary.merkle_root;
    $("#verify-out").innerHTML = ok
      ? `<span class="ok">included</span> <span class="mono small">leaf ${leaf.slice(0, 18)}… · ${f.proof.length}-step proof</span>`
      : `<span class="bad">not included</span>`;
  });
}

// ---------------- contract demo ----------------
let chain = null, reg = null, artifact = null;
const log = (line) => { const el = $("#log"); el.textContent += `\n${line}`; el.scrollTop = el.scrollHeight; };
const btn = (id, on) => { $(id).disabled = !on; };
const done = (id) => $(id).classList.add("done");

function resetDemo() {
  chain = null; reg = null;
  for (const id of ["#b-deploy", "#b-replay", "#b-link", "#b-double", "#b-anchor"]) $(id).classList.remove("done");
  btn("#b-deploy", true); btn("#b-replay", false); btn("#b-link", false); btn("#b-double", false); btn("#b-anchor", false);
  $("#log").textContent = "Ready. Step 1 deploys CreditClaimRegistry into an in-browser EVM (Cancun).";
}

const operatorFor = (r) => ({ VCS: "verra", GOLD: "goldstandard", CAR: "car", ACR: "acr" })[r] ?? "car";

function wireDemo() {
  $("#b-deploy").addEventListener("click", async () => {
    btn("#b-deploy", false);
    artifact = artifact ?? (await (await fetch("./contract/CreditClaimRegistry.json")).json());
    chain = await createChain();
    const { owner, auditor } = chain.accounts;
    reg = await chain.deploy(artifact, owner);
    log(`deployed CreditClaimRegistry at ${reg.address} (${artifact.compiler.split("+")[0]})`);
    for (const r of [selected.registry_a, selected.registry_b]) {
      const op = chain.accounts[operatorFor(r)];
      const res = await reg.send(owner, "addRegistry", [op.hex, code8(r)]);
      log(`addRegistry(${r}) -> operator ${op.hex.slice(0, 10)}…  gas ${res.gasUsed}`);
    }
    await reg.send(owner, "setAuditor", [auditor.hex, true]);
    log(`setAuditor(${auditor.hex.slice(0, 10)}…) — the CarbonTwin auditor`);
    done("#b-deploy"); btn("#b-replay", true);
  });

  $("#b-replay").addEventListener("click", async () => {
    btn("#b-replay", false);
    for (const [id, r, L] of [[selected.a, selected.registry_a, selected.listing_a], [selected.b, selected.registry_b, selected.listing_b]]) {
      const op = chain.accounts[operatorFor(r)];
      for (const [y, v] of Object.entries(L.issued_by_vintage)) {
        const res = await reg.send(op, "recordIssuance", [key(id), Number(y), BigInt(v), keccak256(stringToHex(`${id}-${y}`))]);
        log(`${r.padEnd(4)} recordIssuance(${id}, ${y}, ${fmt(v)})  ${res.ok ? "ok" : "REVERT " + res.error.name}`);
      }
    }
    log("Both registries accepted their own issuances: nothing links the two listings yet.");
    done("#b-replay"); btn("#b-link", true);
  });

  $("#b-link").addEventListener("click", async () => {
    btn("#b-link", false);
    const evidence = selected.leaf ?? leafOf(selected);
    const bps = Math.round((selected.confidence ?? 0.9) * 10000);
    const res = await reg.send(chain.accounts.auditor, "linkListings", [key(selected.a), key(selected.b), bps, evidence]);
    if (!res.ok) { log(`linkListings REVERT ${res.error.name}`); return; }
    const conflicts = res.events.filter((e) => e.name === "ConflictDetected");
    log(`auditor linkListings(${selected.a}, ${selected.b}, confidence ${bps} bps)  gas ${res.gasUsed}`);
    for (const c of conflicts) log(`  event ConflictDetected(vintage ${c.args.vintage}): issued by both registries`);
    log(conflicts.length ? `${conflicts.length} shared vintage(s) are now on the public record.` : "No shared vintages.");
    done("#b-link"); btn("#b-double", true);
  });

  $("#b-double").addEventListener("click", async () => {
    btn("#b-double", false);
    const y = selected.overlap_vintages[selected.overlap_vintages.length - 1] ?? 2023;
    const issuedA = await reg.call("vintageIssuer", [key(selected.a), y]);
    const firstReg = [selected.registry_a, selected.registry_b].find((r) => code8(r) === issuedA) ?? selected.registry_a;
    const second = firstReg === selected.registry_a ? [selected.b, selected.registry_b] : [selected.a, selected.registry_a];
    const op = chain.accounts[operatorFor(second[1])];
    const res = await reg.send(op, "recordIssuance", [key(second[0]), y, 1000n, keccak256(stringToHex(`${second[0]}-${y}-new`))]);
    log(`${second[1]} tries recordIssuance(${second[0]}, ${y}, 1,000) after the link`);
    log(res.ok ? "  accepted (unexpected)" : `  REVERT ${res.error.name}(vintage ${res.error.args?.[1] ?? y}, first issuer ${firstReg})`);
    done("#b-double"); btn("#b-anchor", true);
  });

  $("#b-anchor").addEventListener("click", async () => {
    btn("#b-anchor", false);
    const root = doc.summary.merkle_root;
    const res = await reg.send(chain.accounts.auditor, "anchorReport", [root, "carbontwin://findings.json"]);
    log(`anchorReport(${root.slice(0, 18)}…) -> index 0  gas ${res.gasUsed}`);
    const ok = await reg.call("verifyFinding", [0n, selected.leaf, selected.proof]);
    const forged = await reg.call("verifyFinding", [0n, keccak256(stringToHex("forged finding")), selected.proof]);
    log(`verifyFinding(this finding) = ${ok}`);
    log(`verifyFinding(forged finding) = ${forged}`);
    done("#b-anchor");
  });
}

main().catch((e) => { $("#log").textContent = `Failed to load: ${e.message}`; console.error(e); });
