#!/bin/sh
# Download the Berkeley Carbon Trading Project's Voluntary Registry Offsets Database (CC BY 4.0).
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/data/raw"
mkdir -p "$dir"
curl -fL -o "$dir/Voluntary-Registry-Offsets-Database--v2026-06.xlsx" \
  "https://gspp.berkeley.edu/assets/uploads/page/Voluntary-Registry-Offsets-Database--v2026-06.xlsx"
echo "saved to $dir"
