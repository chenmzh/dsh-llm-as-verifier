#!/usr/bin/env python3
"""Opt-in real-endpoint benchmark for DSV4 verifier compute policies."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

PROVIDER_DIR = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "verification"
    / "verifier-llm-as-verifier"
)
sys.path.insert(0, str(PROVIDER_DIR))

import worker  # noqa: E402


TASKS: dict[str, dict[str, Any]] = {
    "arithmetic": {
        "problem": (
            "Compute 17 + 25 and give the exact answer with one sentence "
            "explaining the addition."
        ),
        "candidates": [
            "17 + 25 = 42: add 20 to 17 to get 37, then add the remaining 5.",
            "42.",
            "The result is approximately 40; no exact sum is given.",
            "17 + 25 = 41 because 17 + 20 = 37 and 37 + 4 = 41.",
            "17 + 25 = 34.",
        ],
        "expected_top_two": [0, 1],
    },
    "reverse": {
        "problem": 'Reverse "straw" and explain the operation in one sentence.',
        "candidates": [
            'The reverse is "warts"; reading the original characters from right to left gives w-a-r-t-s.',
            '"warts".',
            'The reverse is "straw".',
            'The reverse is "warst".',
            "A reverse cannot be determined from the supplied word.",
        ],
        "expected_top_two": [0, 1],
    },
    "logic": {
        "problem": "All wugs are blue. Mina is a wug. State Mina's color and why.",
        "candidates": [
            "Mina is blue because every wug is blue and Mina is a wug.",
            "Mina is blue.",
            "Mina is green because individual wugs can differ.",
            "Mina's color cannot be determined.",
            "Wugs are fictional, so the premises have no answer.",
        ],
        "expected_top_two": [0, 1],
    },
}

CRITERIA = {
    "Overall": "Rank correctness first, then complete compliance with the requested answer."
}


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure DSV4 Best-of-5 cost without changing Harness Workers."
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
        "--matrix",
        default="4:1",
        help="Comma-separated max_workers:n_evaluations entries.",
    )
    parser.add_argument("--tasks", default="arithmetic")
    parser.add_argument("--pivots", type=int, default=2)
    parser.add_argument(
        "--reasoning-effort", choices=("off", "low", "high"), default="high"
    )
    parser.add_argument("--adaptive-top-two", action="store_true")
    parser.add_argument("--top2-gap-threshold", type=float, default=0.08)
    parser.add_argument("--additional-evaluations", type=int, default=1)
    parser.add_argument("--max-extra-calls", type=int, default=8)
    parser.add_argument(
        "--escalation-reasoning-effort",
        choices=("off", "low", "high"),
        default="high",
    )
    parser.add_argument("--thresholds", default="0.03,0.05,0.08,0.10")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def _positive_matrix(value: str) -> list[tuple[int, int]]:
    result = []
    for item in value.split(","):
        max_workers, evaluations = item.split(":", 1)
        pair = (int(max_workers), int(evaluations))
        if pair[0] < 1 or pair[1] < 1:
            raise ValueError("matrix values must be positive integers")
        result.append(pair)
    return result


def _task_names(value: str) -> list[str]:
    names = [name.strip() for name in value.split(",") if name.strip()]
    unknown = [name for name in names if name not in TASKS]
    if not names or unknown:
        raise ValueError(f"unknown or empty task list: {unknown}")
    return names


def _thresholds(value: str) -> list[float]:
    thresholds = [float(item) for item in value.split(",")]
    if any(item < 0 or item > 1 for item in thresholds):
        raise ValueError("thresholds must be in [0, 1]")
    return thresholds


def _persist(payload: dict[str, Any], destination: Path | None) -> None:
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered, flush=True)
    if destination is None:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(f"{destination.suffix}.tmp")
    temporary.write_text(f"{rendered}\n", encoding="utf-8")
    temporary.replace(destination)


def _sum_usage(*values: MappingLike | None) -> dict[str, int]:
    fields = (
        "calls",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_tokens",
    )
    return {
        field: sum(int(value.get(field, 0)) for value in values if value is not None)
        for field in fields
    }


MappingLike = dict[str, Any]


def _selection_request(
    task: MappingLike,
    *,
    max_workers: int,
    n_evaluations: int,
    pivots: int,
    reasoning_effort: str,
    cache_id: str | None,
) -> dict[str, Any]:
    return {
        "operation": "select",
        "problem": task["problem"],
        "candidates": task["candidates"],
        "criteria": CRITERIA,
        "model": worker.VERIFIER_MODEL,
        "n_evaluations": n_evaluations,
        "pivots": pivots,
        "max_workers": max_workers,
        "reasoning_effort": reasoning_effort,
        **({} if cache_id is None else {"cache_id": cache_id}),
    }


def _run_policy(
    module: Any,
    task_name: str,
    task: MappingLike,
    args: argparse.Namespace,
    max_workers: int,
    n_evaluations: int,
    thresholds: list[float],
) -> dict[str, Any]:
    cache_id = f"benchmark-{uuid.uuid4().hex}" if args.adaptive_top_two else None
    baseline_request = _selection_request(
        task,
        max_workers=max_workers,
        n_evaluations=n_evaluations,
        pivots=args.pivots,
        reasoning_effort=args.reasoning_effort,
        cache_id=cache_id,
    )
    baseline_plan = worker._planned_work(module, baseline_request)
    maximum_extra_comparisons = 2 * args.additional_evaluations
    maximum_extra_calls = min(
        args.max_extra_calls,
        maximum_extra_comparisons * len(CRITERIA),
    )
    print(json.dumps({
        "plan": {
            "task": task_name,
            "baseline": baseline_plan,
            "maximum_adaptive_extra_comparisons": maximum_extra_comparisons,
            "maximum_adaptive_extra_calls": maximum_extra_calls,
        }
    }, sort_keys=True), flush=True)

    started = time.perf_counter()
    escalation: MappingLike | None = None
    escalation_reason = None
    try:
        baseline = worker._execute(baseline_request)
        ranking = list(baseline["ranking"])
        scores = list(baseline["scores"])
        gap = scores[ranking[0]] - scores[ranking[1]]
        if args.adaptive_top_two and gap < args.top2_gap_threshold:
            if maximum_extra_comparisons * len(CRITERIA) > args.max_extra_calls:
                escalation_reason = "max_extra_calls"
            else:
                adaptive_pairs = []
                for _ in range(args.additional_evaluations):
                    adaptive_pairs.extend([
                        [ranking[0], ranking[1]],
                        [ranking[1], ranking[0]],
                    ])
                escalation_request = {
                    **baseline_request,
                    "operation": "select_escalation",
                    "baseline_n_evaluations": n_evaluations,
                    "n_evaluations": 1,
                    "adaptive_pairs": adaptive_pairs,
                    "reasoning_effort": args.escalation_reasoning_effort,
                }
                escalation_plan = worker._planned_work(module, escalation_request)
                print(json.dumps({"escalation_plan": escalation_plan}, sort_keys=True), flush=True)
                escalation = worker._execute(escalation_request)
        final = escalation or baseline
    finally:
        if cache_id is not None:
            worker._execute({"operation": "release_cache", "cache_id": cache_id})

    final_ranking = list(final["ranking"])
    baseline_ranking = list(baseline["ranking"])
    expected_top_two = task["expected_top_two"]
    return {
        "task": task_name,
        "max_workers": max_workers,
        "n_evaluations": n_evaluations,
        "reasoning_effort": args.reasoning_effort,
        "adaptive_top_two": args.adaptive_top_two,
        "selected_index": final["selected_index"],
        "ranking": final_ranking,
        "scores": final["scores"],
        "winner_correct": final_ranking[0] == expected_top_two[0],
        "top_two_stable": final_ranking[:2] == expected_top_two,
        "stage1_gap": (
            baseline["scores"][baseline_ranking[0]]
            - baseline["scores"][baseline_ranking[1]]
        ),
        "threshold_decisions": {
            str(threshold): (
                baseline["scores"][baseline_ranking[0]]
                - baseline["scores"][baseline_ranking[1]]
            ) < threshold
            for threshold in thresholds
        },
        "escalation_triggered": escalation is not None,
        "escalation_skipped_reason": escalation_reason,
        "final_winner_changed": final["selected_index"] != baseline["selected_index"],
        "final_ranking_changed": final_ranking != baseline_ranking,
        "latency_ms": round((time.perf_counter() - started) * 1000, 3),
        "baseline": {
            "usage": baseline.get("usage", {}),
            "telemetry": baseline.get("details", {}).get("telemetry", {}),
        },
        "escalation": None if escalation is None else {
            "usage": escalation.get("usage", {}),
            "telemetry": escalation.get("details", {}).get("telemetry", {}),
        },
        "total_usage": _sum_usage(
            baseline.get("usage"),
            None if escalation is None else escalation.get("usage"),
        ),
    }


def main() -> None:
    """Run each requested policy once and persist every completed result."""
    args = _arguments()
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"{args.api_key_env} is not configured")
    os.environ["VERIFIER_API_KEY"] = api_key
    os.environ["VERIFIER_BASE_URL"] = args.base_url
    if args.transport == "auto":
        os.environ.pop("VERIFIER_TRANSPORT", None)
        transport = worker._transport(args.base_url)
    else:
        transport = args.transport
    os.environ["VERIFIER_TRANSPORT"] = transport

    task_names = _task_names(args.tasks)
    thresholds = _thresholds(args.thresholds)
    payload: dict[str, Any] = {
        "model": worker.VERIFIER_MODEL,
        "endpoint": worker._safe_endpoint_identifier(args.base_url),
        "transport": transport,
        "policy": {
            "reasoning_effort": args.reasoning_effort,
            "adaptive_top_two": args.adaptive_top_two,
            "top2_gap_threshold": args.top2_gap_threshold,
            "additional_evaluations": args.additional_evaluations,
            "max_extra_calls": args.max_extra_calls,
            "escalation_reasoning_effort": args.escalation_reasoning_effort,
        },
        "results": [],
    }
    module = worker._module()
    for task_name in task_names:
        for max_workers, n_evaluations in _positive_matrix(args.matrix):
            try:
                result = _run_policy(
                    module,
                    task_name,
                    TASKS[task_name],
                    args,
                    max_workers,
                    n_evaluations,
                    thresholds,
                )
            except Exception as error:
                payload["results"].append({
                    "task": task_name,
                    "max_workers": max_workers,
                    "n_evaluations": n_evaluations,
                    "error": {
                        "code": type(error).__name__,
                        "message": worker._safe_message(error),
                    },
                })
                _persist(payload, args.output)
                raise SystemExit(2) from None
            payload["results"].append(result)
            _persist(payload, args.output)


if __name__ == "__main__":
    main()
