# CarbonTwin

CarbonTwin looks for carbon credit projects that are listed in two registries and issued credits for the same vintage year in both. It then shows how a small smart contract can keep that from happening again: once two listings are linked as one asset, a second registry cannot issue a vintage the first one already issued.

Live demo: https://hyunsikparker.github.io/carbontwin/

Built for the IEEE ClimateChain Global Hackathon 2026, track **Carbon Markets & Emissions Transparency**.

## What it found

| | |
|---|---|
| Registry listings screened | 11,468 |
| Cross-registry candidate pairs | 1,989 |
| Pairs adjudicated by the model | 450 |
| Same asset after every check, with a shared vintage | 18 |
| Credits issued for those shared vintages (smaller side) | 2,486,944 tCO₂e |

A shared vintage is a question for the registries, not proof of double counting. A project that moves from one registry to another can legitimately split a year, and the summary data has no serial numbers, so overlap is counted per vintage using the smaller of the two issuances.

## How it works

1. **Screen** (`pipeline/screen.py`). Compares project names within each country with character n-gram TF-IDF and keeps pairs from different registries whose cosine similarity is at least 0.62. Developer, site, type and stated capacity feed a pre-score that orders the pairs.
2. **Adjudicate** (`pipeline/adjudicate.py`). Gemma 4 12B (QAT, 4-bit) runs locally through llama.cpp at temperature 0. It reads both records and returns a JSON verdict: same asset, different asset, or unclear. This run covered every pair with a shared vintage plus the highest-scoring other pairs, 450 in total.
3. **Verify** (`pipeline/verify.py`). A second pass must list facts that appear in both records, with the value it read from each. Code checks each value against the source records and drops the ones it cannot find. A pair counts as a finding only when both passes say "same asset", at least two shared facts survive, and the two project names do not carry different numbers or distinguishing words (for example "#10" against "62", or two different company names).
4. **Anchor** (`pipeline/report.py`, `pipeline/anchor.mjs`). Each finding is hashed into a sorted-pair Merkle tree. `anchorReport` stores the root on-chain, and any finding can be checked against it.

## The contract

`contracts/src/CreditClaimRegistry.sol` (Solidity 0.8, compiled with solc 0.8.37):

- `recordIssuance(listing, vintage, amount, serialHash)`: a registry operator records an issuance.
- `linkListings(a, b, confidenceBps, evidenceHash)`: the auditor declares that two listings are one asset. Vintages both sides already issued are emitted as `ConflictDetected`; the rest are merged.
- After a link, an issuance by another registry for an already-issued vintage reverts with `DoubleIssuance`.
- `retire(...)` cannot exceed what is left of an issuance (`OverRetirement`).
- `anchorReport(root, uri)` and `verifyFinding(index, leaf, proof)` store and check report roots.

`npm test` runs eleven tests on an in-memory EVM (ethereumjs, Cancun): eight for the contract and three that check every published finding against the report root and the source vintages. The web demo runs the same bytecode in the browser.

## Run it

```sh
npm install
npm run compile && npm test
pip install -r requirements.txt && python3 -m unittest pipeline/test_pipeline.py
sh pipeline/fetch_data.sh               # downloads the Berkeley database (CC BY 4.0)
python3 pipeline/screen.py
llama-server -m gemma-4-12b-it-qat-q4_0.gguf --jinja --reasoning off --port 8095 -a gemma-4-12b &
python3 pipeline/adjudicate.py --limit 450 && python3 pipeline/verify.py
python3 pipeline/report.py && node pipeline/anchor.mjs
npm run dev
```

The repository includes the screening output, both model passes and the report, so `npm run dev` works without the model or the spreadsheet.

## Data

Pamela Quartson, Barbara K Haya, Tyler Bernard, Aline Abayo, Xinyun Rong, Ivy S So, Micah Elias. (2026). Voluntary Registry Offsets Database v2026-06, Berkeley Carbon Trading Project, University of California, Berkeley. Licensed under CC BY 4.0. Files in `data/` are derived from it.

## License

Code: MIT.
