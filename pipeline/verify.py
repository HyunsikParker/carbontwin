"""Stage 2b: second, evidence-bound pass for pairs the first pass called same asset or unclear.

The model must list facts that appear in BOTH listings, each with the value it read from A and
from B, plus the differences it noticed. Code then checks every listed value against the source
records; facts that cannot be found in both records are dropped. A pair is confirmed only when
both passes say "yes" and at least two shared facts survive grounding.

Output: data/evidence.jsonl
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from adjudicate import record_text

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

SYSTEM = (
    "You check whether two carbon-registry listings describe the same physical asset. Use only facts "
    "written in the listings. A shared fact must appear in BOTH listings; if a field is empty or missing "
    "in one listing, it is not shared evidence. Copy values exactly as written. Answer with JSON only."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "same_asset": {"type": "string", "enum": ["yes", "no", "unclear"]},
        "shared_facts": {"type": "array", "items": {"type": "object", "properties": {
            "field": {"type": "string"}, "value_a": {"type": "string"}, "value_b": {"type": "string"}},
            "required": ["field", "value_a", "value_b"]}},
        "differences": {"type": "array", "items": {"type": "string"}},
        "reason": {"type": "string"},
    },
    "required": ["same_asset", "shared_facts", "differences", "reason"],
}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def grounded(value: str, text: str) -> bool:
    v, t = norm(value), norm(text)
    if not v:
        return False
    if v in t:
        return True
    words = [w for w in v.split() if len(w) > 2]
    return bool(words) and sum(w in t.split() for w in words) / len(words) >= 0.8


def ask(api: str, prompt: str) -> dict:
    body = {
        "model": "gemma-4-12b",
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 420,
        "response_format": {"type": "json_object", "schema": SCHEMA},
    }
    req = urllib.request.Request(f"{api}/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as resp:
        out = json.loads(resp.read())
    return json.loads(out["choices"][0]["message"]["content"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8095/v1")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    with gzip.open(DATA / "projects.json.gz", "rt") as fh:
        projects = {p["Project ID"]: p for p in json.load(fh)}
    first = [json.loads(l) for l in (DATA / "verdicts.jsonl").read_text().splitlines()]
    todo = [v for v in first if v["same_asset"] in ("yes", "unclear")]
    out_path = DATA / "evidence.jsonl"
    done = set()
    if out_path.exists():
        done = {(e["a"], e["b"]) for e in map(json.loads, out_path.read_text().splitlines())}
    todo = [v for v in todo if (v["a"], v["b"]) not in done]
    print(f"second pass: {len(todo)} pairs", flush=True)

    def work(v: dict) -> dict:
        a_text, b_text = record_text(projects[v["a"]]), record_text(projects[v["b"]])
        prompt = (f"Listing A\n{a_text}\n\nListing B\n{b_text}\n\nList the facts present in both listings "
                  "(field, value in A, value in B), the differences, whether they are the same physical asset "
                  "(yes/no/unclear) and a one-sentence reason that only uses shared facts.")
        t0 = time.time()
        try:
            r = ask(args.api, prompt)
        except Exception as exc:
            r = {"same_asset": "unclear", "shared_facts": [], "differences": [], "reason": f"error: {exc}"[:200]}
        kept = [f for f in r.get("shared_facts", [])
                if grounded(f.get("value_a", ""), a_text) and grounded(f.get("value_b", ""), b_text)]
        dropped = len(r.get("shared_facts", [])) - len(kept)
        confirmed = v["same_asset"] == "yes" and r.get("same_asset") == "yes" and len(kept) >= 2
        return {"a": v["a"], "b": v["b"], "first_pass": v["same_asset"], "second_pass": r.get("same_asset"),
                "grounded_facts": kept[:8], "dropped_facts": dropped, "differences": r.get("differences", [])[:6],
                "reason": r.get("reason", "")[:400], "confirmed": confirmed, "seconds": round(time.time() - t0, 1)}

    with ThreadPoolExecutor(max_workers=args.workers) as pool, out_path.open("a") as out:
        futures = [pool.submit(work, v) for v in todo]
        for n, fut in enumerate(as_completed(futures), 1):
            e = fut.result()
            out.write(json.dumps(e) + "\n")
            out.flush()
            if n % 20 == 0 or n == len(futures):
                print(f"{n}/{len(futures)}", flush=True)


if __name__ == "__main__":
    main()
