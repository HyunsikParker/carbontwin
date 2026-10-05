"""Stage 2: an open-weight LLM (Gemma 4 12B, run locally) adjudicates screened pairs.

For each candidate pair it reads both registry records and returns a JSON verdict on
whether the two listings describe the same physical asset, with a short reason.
Verdicts are cached in data/verdicts.jsonl so the run can be resumed.

Usage: python pipeline/adjudicate.py [--api http://127.0.0.1:8095/v1] [--limit 600] [--workers 4]
"""

from __future__ import annotations

import argparse
import gzip
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
YEARS = list(range(1996, 2027))

SYSTEM = (
    "You audit carbon-credit registry listings. Two listings from different registries are shown. "
    "Decide whether they describe the same physical asset (same facility, site or programme), which could "
    "lead to the same emission reductions being credited twice. Similar wording alone is not enough: "
    "different capacities, sites, phases, owners or technologies mean different assets. A documented "
    "transfer between registries still counts as the same asset. Answer with JSON only."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "same_asset": {"type": "string", "enum": ["yes", "no", "unclear"]},
        "confidence": {"type": "number"},
        "transfer_mentioned": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["same_asset", "confidence", "transfer_mentioned", "reason"],
}


def vintage_profile(issued: list[float]) -> str:
    parts = [f"{y}:{int(v)}" for y, v in zip(YEARS, issued) if v > 0]
    return ", ".join(parts) if parts else "none"


def record_text(p: dict) -> str:
    fields = [
        ("Registry / ID", f"{p['Voluntary Registry']} {p['Project ID']}"),
        ("Name", p["Project Name"]),
        ("Developer", p["Project Developer"]),
        ("Country / State / Site", f"{p['Country']} / {p['State']} / {p['Project Site Location']}"),
        ("Scope / Type", f"{p['Scope']} / {p['Type']}"),
        ("Methodology", str(p["Methodology / Protocol"])[:160]),
        ("Status", p["Voluntary Status"]),
        ("Credits issued by vintage", vintage_profile(p["issued_by_vintage"])),
        ("Registry notes", (p.get("registry_notes") or "")[:300]),
        ("Database notes", (p.get("bctp_notes") or "")[:300]),
        ("Description", (p.get("description") or "")[:500]),
    ]
    return "\n".join(f"- {k}: {v}" for k, v in fields if v not in (None, "", "None"))


def ask(api: str, prompt: str) -> dict:
    body = {
        "model": "gemma-4-12b",
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 160,
        "response_format": {"type": "json_object", "schema": SCHEMA},
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(f"{api}/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        out = json.loads(resp.read())
    text = out["choices"][0]["message"]["content"]
    return json.loads(text)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8095/v1")
    ap.add_argument("--limit", type=int, default=600)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    with gzip.open(DATA / "projects.json.gz", "rt") as fh:
        projects = {p["Project ID"]: p for p in json.load(fh)}
    cands = json.loads((DATA / "candidates.json").read_text())["candidates"]
    # Every pair with overlapping vintages, then the strongest remaining pairs.
    chosen = [c for c in cands if c["overlap_vintages"]]
    rest = [c for c in cands if not c["overlap_vintages"]]
    chosen += rest[: max(0, args.limit - len(chosen))]

    cache_path = DATA / "verdicts.jsonl"
    done = {}
    if cache_path.exists():
        for line in cache_path.read_text().splitlines():
            v = json.loads(line)
            done[(v["a"], v["b"])] = v
    todo = [c for c in chosen if (c["a"], c["b"]) not in done]
    print(f"pairs selected {len(chosen)}, cached {len(chosen) - len(todo)}, to run {len(todo)}", flush=True)

    def work(c: dict) -> dict:
        prompt = ("Listing A\n" + record_text(projects[c["a"]]) + "\n\nListing B\n" + record_text(projects[c["b"]]) +
                  "\n\nAre A and B the same physical asset? Reply as JSON with same_asset (yes/no/unclear), "
                  "confidence (0-1), transfer_mentioned (true if either listing mentions a move or transfer "
                  "between registries or programmes), and reason (one sentence citing the deciding fields).")
        t0 = time.time()
        for attempt in range(3):
            try:
                v = ask(args.api, prompt)
                break
            except Exception as exc:  # retry transient server errors
                if attempt == 2:
                    v = {"same_asset": "unclear", "confidence": 0.0, "transfer_mentioned": False, "reason": f"error: {exc}"[:200]}
                time.sleep(2)
        v.update({"a": c["a"], "b": c["b"], "seconds": round(time.time() - t0, 1), "model": "gemma-4-12b-it-qat-q4_0"})
        return v

    with ThreadPoolExecutor(max_workers=args.workers) as pool, cache_path.open("a") as out:
        futures = [pool.submit(work, c) for c in todo]
        for n, fut in enumerate(as_completed(futures), 1):
            v = fut.result()
            out.write(json.dumps(v) + "\n")
            out.flush()
            if n % 25 == 0 or n == len(futures):
                print(f"{n}/{len(futures)} last={v['same_asset']} {v['seconds']}s", flush=True)


if __name__ == "__main__":
    main()
