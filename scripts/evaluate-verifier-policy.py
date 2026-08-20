#!/usr/bin/env python3
"""Evaluate top-two trigger coverage from recorded Stage-1 verifier results."""

from __future__ import annotations

import argparse
import json

from verifier_run_analysis import analyze, load_records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="JSONL files or directories")
    parser.add_argument("--threshold", type=float, action="append", required=True)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()
    records, skipped = load_records(args.paths)
    policies = analyze(records, thresholds=args.threshold)["shadow_policies"]
    result = {"runs": len(records), "policies": policies, "skipped": skipped}
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"Runs: {len(records)}")
        for policy in policies:
            inside = policy["inside_escalated_set"]
            outside = policy["outside_escalated_set"]
            print(
                f"threshold={policy['threshold']:.3f} trigger={policy['would_escalate']}/{policy['runs_with_gap']} "
                f"errors_inside={inside['errors']} errors_outside={outside['errors']}"
            )
        print("Shadow analysis does not predict the result of an unexecuted escalation.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
