"""Stage 1: cross-registry screening of the Berkeley Voluntary Registry Offsets Database.

Finds pairs of projects listed in different registries that look like the same physical
asset, then measures whether both registries issued credits for the same vintage years.

Input : data/raw/Voluntary-Registry-Offsets-Database--v2026-06.xlsx (CC BY 4.0, Berkeley
        Carbon Trading Project; see README for the citation)
Output: data/projects.parquet, data/candidates.json
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import openpyxl
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "Voluntary-Registry-Offsets-Database--v2026-06.xlsx"
OUT = ROOT / "data"
YEARS = list(range(1996, 2027))
META = ["Project ID", "Project Name", "Voluntary Registry", "ARB / WA Project", "Voluntary Status",
        "Scope", "Type", "Reduction / Removal", "Methodology / Protocol", "Methodology Version",
        "Region", "Country", "State", "Project Site Location", "Project Developer",
        "Total Credits Issued", "Total Credits Retired", "Total Credits Remaining"]
GENERIC = (r"\b(project|projects|the|of|and|in|at|by|for|programme|program|pvt|ltd|limited|private|co|"
           r"company|sa|inc|llc|bundled|grouped|phase|power|plant|india|china|state)\b")
CAPACITY = re.compile(r"(\d+(?:\.\d+)?)\s*(mw|mwp|mwe|kw|kwp|gw)\b", re.I)
NAME_THRESHOLD = 0.62


def clean(text: object) -> str:
    s = str(text or "").lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(GENERIC, " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load() -> pd.DataFrame:
    wb = openpyxl.load_workbook(RAW, read_only=True)
    ws = wb["PROJECTS"]
    rows = ws.iter_rows(min_row=4, values_only=True)
    header = [str(h).replace("\n", " ").strip() if h is not None else "" for h in next(rows)]
    header = [re.sub(r"\s+", " ", h) for h in header]
    meta_idx = {name: header.index(name) for name in META}
    issued_idx = list(range(23, 54))      # credits issued by vintage year 1996-2026
    remaining_idx = list(range(85, 116))  # credits remaining by vintage year
    desc_idx = header.index("Project Description")
    notes_idx = header.index("Notes from Registry")
    bctp_idx = next(i for i, h in enumerate(header) if h.startswith("Notes from Berkeley"))
    records = []
    for row in rows:
        if not row or not row[0]:
            continue
        rec = {name: row[i] for name, i in meta_idx.items()}
        rec["issued_by_vintage"] = [float(row[i] or 0) if isinstance(row[i], (int, float)) else 0.0 for i in issued_idx]
        rec["remaining_by_vintage"] = [float(row[i] or 0) if isinstance(row[i], (int, float)) else 0.0 for i in remaining_idx]
        rec["description"] = str(row[desc_idx] or "")[:1200]
        rec["registry_notes"] = str(row[notes_idx] or "")[:600]
        rec["bctp_notes"] = str(row[bctp_idx] or "")[:600]
        records.append(rec)
    df = pd.DataFrame(records)
    for col in ("Total Credits Issued", "Total Credits Retired", "Total Credits Remaining"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return df


def capacities(name: str) -> set[float]:
    out = set()
    for num, unit in CAPACITY.findall(name or ""):
        val = float(num)
        unit = unit.lower()
        if unit.startswith("kw"):
            val /= 1000.0
        elif unit == "gw":
            val *= 1000.0
        out.add(round(val, 2))
    return out


def jaccard(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def screen(df: pd.DataFrame) -> list[dict]:
    df = df.copy()
    df["n_name"] = df["Project Name"].map(clean)
    df["n_dev"] = df["Project Developer"].map(clean)
    df["n_loc"] = (df["State"].fillna("").astype(str) + " " + df["Project Site Location"].fillna("").astype(str)).map(clean)
    out = []
    for country, g in df.groupby("Country"):
        if g["Voluntary Registry"].nunique() < 2 or len(g) < 2:
            continue
        names = g["n_name"].tolist()
        if not any(names):
            continue
        vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 4))
        sim = cosine_similarity(vec.fit_transform(names))
        idx = g.index.to_numpy()
        reg = g["Voluntary Registry"].to_numpy()
        ii, jj = np.where(np.triu(sim, 1) >= NAME_THRESHOLD)
        for i, j in zip(ii, jj):
            if reg[i] == reg[j]:
                continue
            a, b = df.loc[idx[i]], df.loc[idx[j]]
            cap_a, cap_b = capacities(str(a["Project Name"])), capacities(str(b["Project Name"]))
            issued_a, issued_b = np.array(a["issued_by_vintage"]), np.array(b["issued_by_vintage"])
            both = (issued_a > 0) & (issued_b > 0)
            out.append({
                "a": a["Project ID"], "b": b["Project ID"],
                "registry_a": a["Voluntary Registry"], "registry_b": b["Voluntary Registry"],
                "country": country,
                "name_sim": round(float(sim[i, j]), 4),
                "dev_sim": round(jaccard(a["n_dev"], b["n_dev"]), 4),
                "loc_sim": round(jaccard(a["n_loc"], b["n_loc"]), 4),
                "same_type": bool(a["Type"] == b["Type"]),
                "same_scope": bool(a["Scope"] == b["Scope"]),
                "capacity_conflict": bool(cap_a and cap_b and not (cap_a & cap_b)),
                "overlap_vintages": [YEARS[k] for k in np.where(both)[0]],
                "overlap_volume": float(np.minimum(issued_a, issued_b)[both].sum()),
                "issued_a": float(a["Total Credits Issued"]), "issued_b": float(b["Total Credits Issued"]),
            })
    return out


def screen_score(c: dict) -> float:
    """Transparent pre-score used to order candidates before LLM adjudication (0-1)."""
    s = 0.55 * c["name_sim"] + 0.2 * c["dev_sim"] + 0.1 * c["loc_sim"]
    s += 0.1 if c["same_type"] else (0.04 if c["same_scope"] else 0.0)
    s -= 0.35 if c["capacity_conflict"] else 0.0
    return round(max(0.0, min(1.0, s + 0.05)), 4)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    df = load()
    keep = META + ["issued_by_vintage", "remaining_by_vintage", "description", "registry_notes", "bctp_notes"]
    df[keep].to_json(OUT / "projects.json.gz", orient="records", compression="gzip")
    cands = screen(df)
    for c in cands:
        c["screen_score"] = screen_score(c)
    cands.sort(key=lambda c: (-c["screen_score"], -c["overlap_volume"]))
    summary = {
        "projects": int(len(df)),
        "registries": df["Voluntary Registry"].value_counts().to_dict(),
        "candidates": len(cands),
        "candidates_with_vintage_overlap": sum(1 for c in cands if c["overlap_vintages"]),
        "name_threshold": NAME_THRESHOLD,
    }
    (OUT / "candidates.json").write_text(json.dumps({"summary": summary, "candidates": cands}, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    sys.exit(main())
