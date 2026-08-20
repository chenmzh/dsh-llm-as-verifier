#!/usr/bin/env python3
"""Export a metadata/reference-only verifier evaluation dataset."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from verifier_run_analysis import load_records, safe_export_record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="JSONL files or directories")
    parser.add_argument("--output", required=True, help="output JSONL path")
    args = parser.parse_args()
    records, skipped = load_records(args.paths)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as destination:
        for record in records:
            destination.write(json.dumps(safe_export_record(record), separators=(",", ":")) + "\n")
    print(
        f"Exported {len(records)} records to {output}; "
        f"skipped unsupported={skipped['unsupported_schema']} malformed={skipped['malformed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
