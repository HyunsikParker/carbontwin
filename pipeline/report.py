"""Stage 3: turn screened pairs and LLM verdicts into findings for the dashboard.

A finding is a pair of listings in different registries that the adjudicator judged to be the
same physical asset. When both registries issued credits for the same vintage year, the
finding records those vintages and the overlapping volume (the smaller of the two issuances
per vintage, summed). Overlap is a reconciliation signal, not proof of double counting:
transfers between registries can legitimately split a vintage.

Output: web/public/data/findings.json (anchored by pipeline/anchor.mjs)
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = ROOT / "web" / "public" / "data"
YEARS = list(range(1996, 2027))
FIELDS = ["Project ID", "Project Name", "Voluntary Registry", "Voluntary Status", "Scope", "Type",
          "Methodology / Protocol", "Country", "State", "Project Site Location", "Project Developer",
          "Total Credits Issued", "Total Credits Retired"]


def listing(p: dict) -> dict:
    out = {k: p.get(k) for k in FIELDS}
    out["issued_by_vintage"] = {str(y): int(v) for y, v in zip(YEARS, p["issued_by_vintage"]) if v}
    out["notes"] = " ".join(x for x in (p.get("registry_notes"), p.get("bctp_notes")) if x and x != "None")[:400]
    return out


def main() -> None:
    with gzip.open(DATA / "projects.json.gz", "rt") as fh:
        projects = {p["Project ID"]: p for p in json.load(fh)}
    cand = json.loads((DATA / "candidates.json").read_text())
    verdicts = {}
    for line in (DATA / "verdicts.jsonl").read_text().splitlines():
        v = json.loads(line)
        verdicts[(v["a"], v["b"])] = v
    evidence = {}
    ev_path = DATA / "evidence.jsonl"
    if ev_path.exists():
        for line in ev_path.read_text().splitlines():
            e = json.loads(line)
            evidence[(e["a"], e["b"])] = e

    findings, review = [], []
    for c in cand["candidates"]:
        v = verdicts.get((c["a"], c["b"]))
        if not v:
            continue
        item = {
            "id": f"{c['a']}~{c['b']}",
            "a": c["a"], "b": c["b"],
            "registry_a": c["registry_a"], "registry_b": c["registry_b"],
            "country": c["country"],
            "screen_score": c["screen_score"], "name_sim": c["name_sim"],
            "overlap_vintages": c["overlap_vintages"],
            "overlap_volume": int(c["overlap_volume"]),
            "verdict": v["same_asset"], "confidence": v.get("confidence"),
            "transfer_mentioned": bool(v.get("transfer_mentioned")),
            "listing_a": listing(projects[c["a"]]), "listing_b": listing(projects[c["b"]]),
        }
        e = evidence.get((c["a"], c["b"]))
        if e:
            item["second_pass"] = e["second_pass"]
            item["shared_facts"] = e["grounded_facts"]
            item["differences"] = e["differences"]
            item["reason"] = e["reason"]
            item["dropped_facts"] = e["dropped_facts"]
        if e and e["confirmed"]:
            findings.append(item)
        elif v["same_asset"] in ("yes", "unclear"):
            review.append(item)

    findings.sort(key=lambda f: (-f["overlap_volume"], -f["screen_score"]))
    overlapping = [f for f in findings if f["overlap_vintages"]]
    summary = {
        **cand["summary"],
        "adjudicated": len(verdicts),
        "same_asset": len(findings),
        "same_asset_with_overlap": len(overlapping),
        "overlap_volume": int(sum(f["overlap_volume"] for f in overlapping)),
        "needs_review": len(review),
        "second_pass": len(evidence),
        "adjudicator": "gemma-4-12b-it-qat-q4_0 (local, llama.cpp, temperature 0)",
        "source": "Berkeley Carbon Trading Project, Voluntary Registry Offsets Database v2026-06 (CC BY 4.0)",
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "findings.json").write_text(json.dumps({"summary": summary, "findings": findings, "review": review[:60]}, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
