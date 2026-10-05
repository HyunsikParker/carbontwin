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
import re
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


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9.]+", " ", str(text).lower())


def checked_reason(reason: str, facts: list, a: dict, b: dict) -> tuple[str, bool]:
    """Keep the model's sentence only if every number in it appears in both records."""
    text_a = _norm(json.dumps(a)) + " " + _norm(a.get("description", ""))
    text_b = _norm(json.dumps(b)) + " " + _norm(b.get("description", ""))
    numbers = re.findall(r"\d+(?:\.\d+)?", reason or "")
    if reason and all(n in text_a and n in text_b for n in numbers):
        return reason, True
    shared = [f"{x['field'].lower()} ({x['value_a']})" for x in facts[:4]]
    return ("Both records share " + ", ".join(shared) + "." if shared else ""), False


GENERIC_NAME = set("""project projects programme program the of and in at by for with from to on
power plant plants energy renewable solar wind hydro hydropower hydroelectric biogas biomass grid connected
landfill gas methane destruction recovery utilization utilisation treatment wastewater farm farms park windfarm windpark solarpark
pvt ltd limited private co company inc llc corporation group sa cer ver vcs gs gold standard bundled grouped
phase mw mwp kw kwp""".split())


def distinct_tokens(name: str) -> set[str]:
    text = re.sub(r"\.", "", str(name).lower())          # "P.S.C" -> "psc"
    return {t for t in re.findall(r"[a-z0-9]+", text) if t.isdigit() or (len(t) > 1 and t not in GENERIC_NAME)}


def name_conflict(name_a: str, name_b: str) -> bool:
    """True when the names carry different numbers, or each has a distinguishing word the other lacks."""
    ta, tb = distinct_tokens(name_a), distinct_tokens(name_b)
    nums_a = {t for t in ta if t.isdigit()}
    nums_b = {t for t in tb if t.isdigit()}
    if nums_a != nums_b:
        return True
    return bool(ta - tb) and bool(tb - ta)


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
            item["reason"], item["reason_from_model"] = checked_reason(
                e["reason"], e["grounded_facts"], projects[c["a"]], projects[c["b"]])
            item["dropped_facts"] = e["dropped_facts"]
        conflict = name_conflict(item["listing_a"]["Project Name"], item["listing_b"]["Project Name"])
        item["name_conflict"] = conflict
        if e and e["confirmed"] and not conflict:
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
