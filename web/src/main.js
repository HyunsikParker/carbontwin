import { keccak256, stringToHex } from "viem";
import { code8, createChain, key } from "../../contracts/chain.mjs";
import { leafOf, rootFromProof } from "../../contracts/leaf.mjs";

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString("en-US");
// Model strings that hit the schema length cap in pipeline/verify.py were cut there; mark the cut.
const capped = (s, n) => esc(s) + (String(s ?? "").length >= n ? "…" : "");
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
  renderPairs();
  renderTable();
  renderHero([...doc.findings].sort((x, y) => y.overlap_volume - x.overlap_volume)[0]);
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

const colorOf = (r) => getComputedStyle(document.documentElement).getPropertyValue(`--${r === "GOLD" ? "gold" : r.toLowerCase()}`).trim() || "#8a9590";

// Mirrored vintage chart: listing A grows up from the year axis, listing B grows down.
function mirrorChart(f, { W = 720, H = 230, dark = false } = {}) {
  const a = f.listing_a.issued_by_vintage, b = f.listing_b.issued_by_vintage;
  const years = [...new Set([...Object.keys(a), ...Object.keys(b)])].map(Number).sort((x, y) => x - y);
  if (!years.length) return "";
  const span = [];
  for (let y = years[0]; y <= years[years.length - 1]; y++) span.push(y);
  const max = Math.max(...span.map((y) => Math.max(a[y] || 0, b[y] || 0)), 1);
  const mid = H / 2, axis = 11, half = mid - axis - 6, bw = W / span.length, gap = Math.max(5, bw * 0.24);
  const shade = dark ? `fill="rgba(239,106,67,0.13)" stroke="rgba(255,150,118,0.6)" stroke-dasharray="4 3"` : `fill="#fde8df"`;
  const label = dark ? "#8fb0a5" : "#5b6c65";
  let svg = "";
  span.forEach((y, i) => {
    const x = i * bw;
    if (f.overlap_vintages.includes(y)) svg += `<rect x="${(x + 1).toFixed(1)}" y="2" width="${(bw - 2).toFixed(1)}" height="${H - 4}" rx="7" ${shade}/>`;
    const ha = ((a[y] || 0) / max) * half, hb = ((b[y] || 0) / max) * half;
    if (ha) svg += `<rect x="${(x + gap / 2).toFixed(1)}" y="${(mid - axis - ha).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${ha.toFixed(1)}" rx="3" fill="${colorOf(f.registry_a)}"><title>${esc(f.a)} ${y}: ${fmt(a[y])}</title></rect>`;
    if (hb) svg += `<rect x="${(x + gap / 2).toFixed(1)}" y="${(mid + axis).toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${hb.toFixed(1)}" rx="3" fill="${colorOf(f.registry_b)}"><title>${esc(f.b)} ${y}: ${fmt(b[y])}</title></rect>`;
    svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${mid + 4}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle" fill="${label}">'${String(y).slice(2)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Credits issued by vintage: ${esc(f.a)} above the axis, ${esc(f.b)} below">${svg}</svg>`;
}

function renderHero(f) {
  if (!f) return;
  const L = (x) => x["Project Name"];
  $("#hero-twin").innerHTML = `
    <div class="twin-head"><span>Largest finding</span><span>${esc(f.country)}</span></div>
    <div class="twin-row"><span class="chip ${f.registry_a}">${esc(f.a)}</span><span class="nm">${esc(L(f.listing_a))}</span><span class="rg">${esc(REG_NAME[f.registry_a] ?? f.registry_a)}</span></div>
    ${mirrorChart(f, { W: 520, H: 200, dark: true })}
    <div class="twin-row"><span class="chip ${f.registry_b}">${esc(f.b)}</span><span class="nm">${esc(L(f.listing_b))}</span><span class="rg">${esc(REG_NAME[f.registry_b] ?? f.registry_b)}</span></div>
    <div class="twin-foot">
      <div><b>${fmt(f.overlap_volume)} t</b><small>issued by both for ${f.overlap_vintages.join(", ")}</small></div>
      <div class="stamp">after linking: new ${f.overlap_vintages[f.overlap_vintages.length - 1]} issuance<br>reverts DoubleIssuance</div>
    </div>`;
}

function renderPairs() {
  const agg = new Map();
  for (const f of doc.findings.filter((x) => x.overlap_vintages.length)) {
    const k = pairLabel(f);
    const a = agg.get(k) || { n: 0, vol: 0 };
    a.n += 1; a.vol += f.overlap_volume; agg.set(k, a);
  }
  const rows = [...agg.entries()].sort((x, y) => y[1].vol - x[1].vol);
  $("#pairs").innerHTML = rows.map(([k, a]) => `<button class="pairchip" data-pair="${esc(k)}"><b>${esc(k)}</b> ${a.n} pair${a.n > 1 ? "s" : ""} · ${fmt(a.vol)} t</button>`).join("");
  for (const b of document.querySelectorAll(".pairchip")) {
    b.addEventListener("click", () => { $("#pair-filter").value = b.dataset.pair; renderTable(); });
  }
}

function visible() {
  const only = $("#only-overlap").checked;
  const pair = $("#pair-filter").value;
  return doc.findings.filter((f) => (!only || f.overlap_vintages.length) && (!pair || pairLabel(f) === pair));
}

function renderTable() {
  const rows = visible();
  const top = Math.max(...doc.findings.map((f) => f.overlap_volume), 1);
  $("#table tbody").innerHTML = rows
    .map((f, i) => `
    <tr class="row${selected === f ? " active" : ""}" data-i="${doc.findings.indexOf(f)}" tabindex="0" aria-label="${esc(f.a)} and ${esc(f.b)}">
      <td><span class="chip ${f.registry_a}">${esc(f.a)}</span><span class="chip ${f.registry_b}">${esc(f.b)}</span>
          <span class="lname">${esc(f.listing_a["Project Name"])}</span></td>
      <td>${esc(f.country)}</td>
      <td>${f.overlap_vintages.map((y) => `<span class="vint">${y}</span>`).join("") || "—"}</td>
      <td class="num"><div class="ov"><span class="ov-track"><i style="width:${Math.max(4, 100 * Math.sqrt(f.overlap_volume / top)).toFixed(1)}%"></i></span>${fmt(f.overlap_volume)}</div></td>
      <td class="verdict"><span class="yes">same asset</span><span class="small">${(f.shared_facts || []).length} facts checked</span></td>
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
  const svg = mirrorChart(f, { W: 1060, H: 220 });
  if (!svg) return "";
  return `<div class="chart">${svg}
    <div class="legend"><span><i style="background:${colorOf(f.registry_a)}"></i>${esc(f.a)} (above the axis)</span><span><i style="background:${colorOf(f.registry_b)}"></i>${esc(f.b)} (below)</span><span><i style="background:#fde8df"></i>vintage issued by both</span></div></div>`;
}

function facts(f) {
  const rows = (f.shared_facts || []).map((x) => `<tr><td>${esc(x.field)}</td><td>${capped(x.value_a, 80)}</td><td>${capped(x.value_b, 80)}</td></tr>`).join("");
  const diffs = (f.differences || []).filter(Boolean);
  return `<div class="facts-wrap"><table class="facts"><thead><tr><th>Shared fact (found in both records)</th><th>${esc(f.a)}</th><th>${esc(f.b)}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${diffs.length ? `<p class="diffs"><b>Differences the model noted:</b> ${diffs.map((d) => capped(d, 120)).join("; ")}</p>` : ""}`;
}

function renderDetail(f) {
  const el = $("#detail");
  el.hidden = false;
  el.innerHTML = `
    <h3>${esc(f.a)} and ${esc(f.b)}</h3>
    ${chart(f)}
    <div class="reason"><b>Model verdict:</b> same asset in both passes${f.transfer_mentioned ? " · a registry transfer is mentioned" : ""}<br>${capped(f.reason, 300)}</div>
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
// Colour each log line by what it reports: reverts and rejections, events, successful checks.
function paint(line) {
  if (/REVERT|= false$|unexpected/.test(line)) return `<span class="err">${esc(line)}</span>`;
  if (/event |shared vintage/.test(line)) return `<span class="evt">${esc(line)}</span>`;
  if (/= true$/.test(line)) return `<span class="okv">${esc(line)}</span>`;
  if (/ {2}ok$/.test(line)) return `${esc(line.slice(0, -2))}<span class="okv">ok</span>`;
  return esc(line);
}
const log = (line) => { const el = $("#log"); el.insertAdjacentHTML("beforeend", `\n${paint(line)}`); el.scrollTop = el.scrollHeight; };
const btn = (id, on) => { $(id).disabled = !on; };
const done = (id) => $(id).classList.add("done");

function resetDemo() {
  chain = null; reg = null;
  for (const id of ["#b-deploy", "#b-replay", "#b-link", "#b-double", "#b-anchor"]) $(id).classList.remove("done");
  btn("#b-deploy", true); btn("#b-replay", false); btn("#b-link", false); btn("#b-double", false); btn("#b-anchor", false);
  $("#log").innerHTML = `<span class="dim">Ready. Step 1 deploys CreditClaimRegistry into an in-browser EVM (Cancun).</span>`;
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
