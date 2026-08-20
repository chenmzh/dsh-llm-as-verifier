#!/usr/bin/env python3
"""Report offline quality and cost metrics from DSH verifier JSONL records."""

from __future__ import annotations

import argparse
import json

from verifier_run_analysis import DEFAULT_BUCKETS, DEFAULT_THRESHOLDS, analyze, format_report, load_records


def _floats(value: str) -> tuple[float, ...]:
    return tuple(float(item) for item in value.split(",") if item.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="JSONL files or directories")
    parser.add_argument("--thresholds", type=_floats, default=DEFAULT_THRESHOLDS)
    parser.add_argument("--gap-buckets", type=_floats, default=DEFAULT_BUCKETS)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()
    records, skipped = load_records(args.paths)
    report = analyze(records, args.thresholds, args.gap_buckets)
    if args.json:
        print(json.dumps({"analysis": report, "skipped": skipped}, indent=2, sort_keys=True))
    else:
        print(format_report(report, skipped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
