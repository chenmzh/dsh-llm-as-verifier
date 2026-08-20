#!/usr/bin/env python3
"""Manual real-endpoint smoke for the DSV4 fine-grained verifier."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

PROVIDER_DIR = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "verification"
    / "verifier-llm-as-verifier"
)
sys.path.insert(0, str(PROVIDER_DIR))

import worker  # noqa: E402


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run two opposite-order DSV4 direct pairwise diagnostics."
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("VERIFIER_BASE_URL", worker.DEFAULT_VERIFIER_BASE_URL),
    )
    parser.add_argument(
        "--transport",
        choices=("auto", "deepseek-native", "openai-compatible"),
        default=os.environ.get("VERIFIER_TRANSPORT", "auto"),
    )
    parser.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    parser.add_argument(
        "--probe-max-tokens",
        type=int,
        default=int(os.environ.get(
            "VERIFIER_PROBE_MAX_TOKENS", worker.DEFAULT_PROBE_MAX_TOKENS
        )),
    )
    parser.add_argument(
        "--probe-retry-max-tokens",
        type=int,
        default=int(os.environ.get(
            "VERIFIER_PROBE_RETRY_MAX_TOKENS",
            worker.DEFAULT_PROBE_RETRY_MAX_TOKENS,
        )),
    )
    parser.add_argument(
        "--score-prefill-max-tokens",
        type=int,
        default=int(os.environ.get(
            "VERIFIER_SCORE_PREFILL_MAX_TOKENS",
            worker.DEFAULT_SCORE_PREFILL_MAX_TOKENS,
        )),
    )
    parser.add_argument("--capability-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    """Run the real verifier and print sanitized probability and usage metrics."""
    args = _arguments()
    api_key = os.environ.get(args.api_key_env)
    if api_key:
        os.environ["VERIFIER_API_KEY"] = api_key
    os.environ["VERIFIER_BASE_URL"] = args.base_url
    if args.transport == "auto":
        os.environ.pop("VERIFIER_TRANSPORT", None)
        transport = worker._transport(args.base_url)
    else:
        transport = args.transport
    os.environ["VERIFIER_TRANSPORT"] = transport
    os.environ["VERIFIER_PROBE_MAX_TOKENS"] = str(args.probe_max_tokens)
    os.environ["VERIFIER_PROBE_RETRY_MAX_TOKENS"] = str(
        args.probe_retry_max_tokens
    )
    os.environ["VERIFIER_SCORE_PREFILL_MAX_TOKENS"] = str(
        args.score_prefill_max_tokens
    )

    if args.capability_only:
        module = worker._module()
        before = worker._usage_snapshot(module)
        started = time.perf_counter()
        try:
            probe = worker._ensure_capability(module)
            failure = None
        except (worker.VerifierProbeInconclusive, worker.VerifierCapabilityError) as error:
            probe = dict(error.details)
            failure = {
                "code": type(error).__name__,
                "message": worker._safe_message(error),
            }
        latency_ms = (time.perf_counter() - started) * 1000
        usage = worker._usage_delta(before, worker._usage_snapshot(module))
        print(json.dumps({
            "model": worker.VERIFIER_MODEL,
            "transport": transport,
            "base_url": args.base_url,
            "probe": probe,
            "failure": failure,
            "usage": usage,
            "latency_ms": round(latency_ms, 1),
        }, indent=2, sort_keys=True))
        if failure is not None:
            raise SystemExit(2)
        return

    problem = 'Return the reverse of "abc".'
    candidates = ['Returns "cba".', 'Returns "abc".']
    directions = [(0, 1), (1, 0)]
    module = worker._module()
    before = worker._usage_snapshot(module)
    started = time.perf_counter()
    comparisons = []
    try:
        for candidate_a, candidate_b in directions:
            result = worker._execute({
                "operation": "compare",
                "problem": problem,
                "candidate_a": candidates[candidate_a],
                "candidate_b": candidates[candidate_b],
                "criteria": {
                    "Correctness": (
                        "Does the candidate return the exact reversed string?"
                    )
                },
                "model": worker.VERIFIER_MODEL,
                "n_evaluations": 1,
                "max_workers": 1,
            })
            records = result.get("details", {}).get("comparisons", [])
            if len(records) != 1:
                raise RuntimeError(
                    "direct verifier diagnostic did not return one comparison record"
                )
            record = records[0]
            if "score_a" not in record or "score_b" not in record:
                raise worker.VerifierCapabilityError(
                    f"{worker.CAPABILITY_ERROR} Direct diagnostic omitted score evidence."
                )
            scores = result["scores"]
            semantic_winner = (
                candidate_a
                if scores[0] > scores[1]
                else candidate_b if scores[1] > scores[0] else None
            )
            comparisons.append({
                "candidate_a_index": candidate_a,
                "candidate_b_index": candidate_b,
                "semantic_winner": semantic_winner,
                "scores": scores,
                "diagnostic": record,
            })
    except (worker.VerifierProbeInconclusive, worker.VerifierCapabilityError) as error:
        latency_ms = (time.perf_counter() - started) * 1000
        print(json.dumps({
            "base_url": args.base_url,
            "failure": {
                "code": type(error).__name__,
                "details": dict(error.details),
                "message": worker._safe_message(error),
            },
            "latency_ms": round(latency_ms, 1),
            "model": worker.VERIFIER_MODEL,
            "transport": transport,
            "usage": worker._usage_delta(
                before, worker._usage_snapshot(module)
            ),
        }, indent=2, sort_keys=True))
        raise SystemExit(2) from None

    latency_ms = (time.perf_counter() - started) * 1000
    usage = worker._usage_delta(before, worker._usage_snapshot(module))
    winners = [item["semantic_winner"] for item in comparisons]
    if winners == [0, 0]:
        classification = "semantic_success"
    elif winners == [1, 1]:
        classification = "raw_semantic_failure"
    elif all(
        winner == direction[0]
        for winner, direction in zip(winners, directions, strict=True)
    ):
        classification = "slot_a_bias"
    elif all(
        winner == direction[1]
        for winner, direction in zip(winners, directions, strict=True)
    ):
        classification = "slot_b_bias"
    elif None in winners:
        classification = "inconclusive_tie"
    else:
        classification = "slot_sensitivity"

    print(json.dumps({
        "model": worker.VERIFIER_MODEL,
        "transport": transport,
        "base_url": args.base_url,
        "classification": classification,
        "comparisons": comparisons,
        "usage": usage,
        "latency_ms": round(latency_ms, 1),
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
