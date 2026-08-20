#!/usr/bin/env python3
"""Offline metrics for privacy-minimized DSH verifier evaluation records."""

from __future__ import annotations

import json
import math
import statistics
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

SUPPORTED_SCHEMA_VERSION = 1
DEFAULT_THRESHOLDS = (0.03, 0.05, 0.08, 0.10)
DEFAULT_BUCKETS = (0.03, 0.05, 0.08, 0.10)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _record_files(paths: Sequence[str]) -> list[Path]:
    files: set[Path] = set()
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            files.update(candidate for candidate in path.rglob("*.jsonl") if candidate.is_file())
        elif path.is_file():
            files.add(path)
        else:
            raise FileNotFoundError(f"evaluation path does not exist: {path}")
    return sorted(files)


def load_records(paths: Sequence[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Load schema-v1 JSONL records and count unsupported or malformed lines."""
    records: list[dict[str, Any]] = []
    skipped = {"unsupported_schema": 0, "malformed": 0}
    for path in _record_files(paths):
        with path.open("r", encoding="utf-8") as source:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    skipped["malformed"] += 1
                    continue
                if not isinstance(value, dict):
                    skipped["malformed"] += 1
                    continue
                if value.get("schema_version") != SUPPORTED_SCHEMA_VERSION:
                    skipped["unsupported_schema"] += 1
                    continue
                records.append(value)
    return records, skipped


def _outcome_quality(outcome: Any) -> float | None:
    if not isinstance(outcome, dict) or outcome.get("status") != "graded":
        return None
    score = outcome.get("score")
    if _is_number(score):
        return float(score)
    success = outcome.get("success")
    return float(success) if isinstance(success, bool) else None


def _outcome_success(outcome: Any) -> bool | None:
    if not isinstance(outcome, dict) or outcome.get("status") != "graded":
        return None
    success = outcome.get("success")
    return success if isinstance(success, bool) else None


def _candidates(record: dict[str, Any]) -> list[dict[str, Any]]:
    value = record.get("candidates")
    return [candidate for candidate in value if isinstance(candidate, dict)] if isinstance(value, list) else []


def _winner_index(record: dict[str, Any]) -> int | None:
    selection = record.get("selection")
    value = selection.get("winner_index") if isinstance(selection, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _candidate(record: dict[str, Any], index: int) -> dict[str, Any] | None:
    return next((item for item in _candidates(record) if item.get("index") == index), None)


def _selected_success(record: dict[str, Any]) -> bool | None:
    winner = _winner_index(record)
    if winner is not None:
        selected = _candidate(record, winner)
        if selected is not None:
            success = _outcome_success(selected.get("outcome"))
            if success is not None:
                return success
    return _outcome_success(record.get("outcome"))


def _complete_qualities(record: dict[str, Any]) -> list[tuple[int, float]] | None:
    candidates = _candidates(record)
    expected = record.get("task_metadata", {}).get("candidate_count")
    if not isinstance(expected, int) or expected < 1 or len(candidates) != expected:
        return None
    qualities: list[tuple[int, float]] = []
    for candidate in candidates:
        index = candidate.get("index")
        quality = _outcome_quality(candidate.get("outcome"))
        if not isinstance(index, int) or isinstance(index, bool) or quality is None:
            return None
        qualities.append((index, quality))
    return qualities


def _selection_error(record: dict[str, Any]) -> bool | None:
    qualities = _complete_qualities(record)
    winner = _winner_index(record)
    if qualities is not None and winner is not None:
        selected = next((quality for index, quality in qualities if index == winner), None)
        return None if selected is None else selected < max(quality for _, quality in qualities)
    success = _selected_success(record)
    return None if success is None else not success


def _top2_gap(record: dict[str, Any]) -> float | None:
    selection = record.get("selection")
    value = selection.get("top2_gap") if isinstance(selection, dict) else None
    return float(value) if _is_number(value) and value >= 0 else None


def _regret(record: dict[str, Any]) -> float | None:
    qualities = _complete_qualities(record)
    winner = _winner_index(record)
    if qualities is None or winner is None:
        return None
    selected = next((quality for index, quality in qualities if index == winner), None)
    return None if selected is None else max(quality for _, quality in qualities) - selected


def _rate(values: Iterable[bool]) -> dict[str, Any]:
    items = list(values)
    successes = sum(items)
    return {"sample_size": len(items), "successes": successes, "rate": successes / len(items) if items else None}


def _average(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _cost(records: Sequence[dict[str, Any]]) -> dict[str, Any]:
    fields = (
        "comparisons", "verifier_calls", "input_tokens", "cached_input_tokens",
        "output_tokens", "reasoning_tokens", "latency_ms",
    )
    result: dict[str, Any] = {}
    for field in fields:
        values = [float(cost[field]) for record in records
                  if isinstance((cost := record.get("cost")), dict) and _is_number(cost.get(field))]
        result[field] = {"total": sum(values), "average_per_run": _average(values)}
    return result


def _gap_bucket_label(lower: float | None, upper: float | None) -> str:
    if lower is None:
        return f"< {upper:g}"
    if upper is None:
        return f">= {lower:g}"
    return f"{lower:g}-{upper:g}"


def _gap_buckets(records: Sequence[dict[str, Any]], boundaries: Sequence[float]) -> list[dict[str, Any]]:
    edges = sorted(set(boundaries))
    buckets: list[dict[str, Any]] = []
    limits: list[tuple[float | None, float | None]] = [(None, edges[0])] if edges else [(None, None)]
    limits.extend((left, right) for left, right in zip(edges, edges[1:]))
    if edges:
        limits.append((edges[-1], None))
    for lower, upper in limits:
        members = [record for record in records if (gap := _top2_gap(record)) is not None
                   and (lower is None or gap >= lower) and (upper is None or gap < upper)]
        errors = [error for record in members if (error := _selection_error(record)) is not None]
        regrets = [regret for record in members if (regret := _regret(record)) is not None]
        buckets.append({
            "bucket": _gap_bucket_label(lower, upper),
            "runs": len(members),
            "runs_with_outcome": len(errors),
            "winner_error_rate": sum(errors) / len(errors) if errors else None,
            "mean_regret": _average(regrets),
        })
    return buckets


def _policy(records: Sequence[dict[str, Any]], threshold: float) -> dict[str, Any]:
    with_gap = [record for record in records if _top2_gap(record) is not None]
    triggered = [record for record in with_gap if float(_top2_gap(record)) < threshold]
    not_triggered = [record for record in with_gap if float(_top2_gap(record)) >= threshold]

    def error_summary(items: Sequence[dict[str, Any]]) -> dict[str, Any]:
        errors = [error for record in items if (error := _selection_error(record)) is not None]
        return {
            "runs_with_outcome": len(errors),
            "errors": sum(errors),
            "error_rate": sum(errors) / len(errors) if errors else None,
        }

    inside = error_summary(triggered)
    outside = error_summary(not_triggered)
    return {
        "threshold": threshold,
        "runs_with_gap": len(with_gap),
        "would_escalate": len(triggered),
        "escalation_rate": len(triggered) / len(with_gap) if with_gap else None,
        "inside_escalated_set": inside,
        "outside_escalated_set": outside,
        "false_positive_escalations": inside["runs_with_outcome"] - inside["errors"],
        "note": "Shadow policy reports trigger coverage only; it does not predict an unexecuted escalation result.",
    }


def _actual_adaptive(records: Sequence[dict[str, Any]]) -> dict[str, Any]:
    escalations = 0
    winner_changes = 0
    corrected = 0
    harmful = 0
    extra_reasoning = 0.0
    for record in records:
        actual = record.get("adaptive_actual")
        if not isinstance(actual, dict) or actual.get("escalation_triggered") is not True:
            continue
        escalations += 1
        winner_changes += actual.get("final_winner_changed") is True
        cost = record.get("cost")
        escalation_cost = cost.get("escalation") if isinstance(cost, dict) else None
        if isinstance(escalation_cost, dict) and _is_number(escalation_cost.get("reasoning_tokens")):
            extra_reasoning += float(escalation_cost["reasoning_tokens"])
        qualities = _complete_qualities(record)
        final_winner = _winner_index(record)
        stage1_winner = actual.get("stage1_winner_index")
        if qualities is None or final_winner is None or not isinstance(stage1_winner, int):
            continue
        quality_by_index = dict(qualities)
        stage1_quality = quality_by_index.get(stage1_winner)
        final_quality = quality_by_index.get(final_winner)
        if stage1_quality is None or final_quality is None:
            continue
        oracle = max(quality_by_index.values())
        corrected += stage1_quality < oracle and final_quality == oracle
        harmful += final_quality < stage1_quality
    return {
        "escalations": escalations,
        "winner_changes": winner_changes,
        "corrected_winners": corrected,
        "harmful_winner_changes": harmful,
        "escalation_yield": corrected / escalations if escalations else None,
        "extra_reasoning_tokens": extra_reasoning,
        "extra_reasoning_tokens_per_correction": extra_reasoning / corrected if corrected else None,
    }


def analyze(records: Sequence[dict[str, Any]], thresholds: Sequence[float] = DEFAULT_THRESHOLDS,
            buckets: Sequence[float] = DEFAULT_BUCKETS) -> dict[str, Any]:
    """Calculate selection, calibration, regret, adaptive, and cost metrics."""
    selected_successes = [value for record in records if (value := _selected_success(record)) is not None]
    baseline_successes: list[bool] = []
    paired_selected: list[bool] = []
    paired_baseline: list[bool] = []
    oracle_successes: list[bool] = []
    winner_correct: list[bool] = []
    regrets: list[float] = []
    for record in records:
        baseline = _candidate(record, 0)
        baseline_success = _outcome_success(baseline.get("outcome")) if baseline is not None else None
        if baseline_success is not None:
            baseline_successes.append(baseline_success)
        selected_success = _selected_success(record)
        if baseline_success is not None and selected_success is not None:
            paired_baseline.append(baseline_success)
            paired_selected.append(selected_success)
        candidates = _candidates(record)
        if candidates and all(_outcome_success(candidate.get("outcome")) is not None for candidate in candidates):
            oracle_successes.append(any(_outcome_success(candidate.get("outcome")) for candidate in candidates))
        error = _selection_error(record)
        if _complete_qualities(record) is not None and error is not None:
            winner_correct.append(not error)
        regret = _regret(record)
        if regret is not None:
            regrets.append(regret)
    paired_selected_rate = _rate(paired_selected)
    paired_baseline_rate = _rate(paired_baseline)
    uplift = None
    if paired_selected_rate["rate"] is not None and paired_baseline_rate["rate"] is not None:
        uplift = 100 * (paired_selected_rate["rate"] - paired_baseline_rate["rate"])
    known_ground_truth = sum(_selection_error(record) is not None for record in records)
    return {
        "runs": len(records),
        "runs_with_ground_truth": known_ground_truth,
        "verifier_winner_success": _rate(selected_successes),
        "baseline_candidate_success": _rate(baseline_successes),
        "oracle_best_success": _rate(oracle_successes),
        "winner_accuracy": _rate(winner_correct),
        "paired_selection_uplift": {
            "sample_size": len(paired_selected),
            "verifier_success_rate": paired_selected_rate["rate"],
            "baseline_success_rate": paired_baseline_rate["rate"],
            "absolute_percentage_points": uplift,
        },
        "regret": {
            "sample_size": len(regrets),
            "mean": _average(regrets),
            "median": statistics.median(regrets) if regrets else None,
            "max": max(regrets) if regrets else None,
            "zero_regret_rate": sum(value == 0 for value in regrets) / len(regrets) if regrets else None,
        },
        "cost": _cost(records),
        "gap_buckets": _gap_buckets(records, buckets),
        "shadow_policies": [_policy(records, threshold) for threshold in sorted(set(thresholds))],
        "actual_adaptive": _actual_adaptive(records),
    }


def safe_export_record(record: dict[str, Any]) -> dict[str, Any]:
    """Whitelist schema-v1 fields suitable for metadata/reference-only replay datasets."""
    def pick(value: Any, keys: Sequence[str]) -> dict[str, Any]:
        return {key: value[key] for key in keys if isinstance(value, dict) and key in value}

    cost_keys = (
        "comparisons", "verifier_calls", "input_tokens", "cached_input_tokens",
        "output_tokens", "reasoning_tokens", "latency_ms",
    )
    cost = pick(record.get("cost"), ("planned_comparisons", "planned_verifier_calls", *cost_keys))
    raw_cost = record.get("cost")
    if isinstance(raw_cost, dict):
        for phase in ("baseline", "escalation"):
            if isinstance(raw_cost.get(phase), dict):
                cost[phase] = pick(raw_cost[phase], cost_keys)
    candidates = []
    for candidate in _candidates(record):
        candidates.append({
            **pick(candidate, ("index", "trajectory_reference_sha256")),
            "outcome": pick(candidate.get("outcome"), ("status", "source", "success", "score")),
        })
    exported = pick(record, ("schema_version", "record_id", "run_id", "task_id", "timestamp"))
    exported.update({
        "task_metadata": pick(record.get("task_metadata"), ("task_type", "source", "candidate_count")),
        "verifier": pick(record.get("verifier"), (
            "backend", "model", "endpoint_id", "reasoning_effort", "criteria_count",
            "n_evaluations", "pivots", "max_workers",
        )),
        "selection": pick(record.get("selection"), (
            "ranking", "scores", "winner_index", "top2_gap", "failure_code",
        )),
        "cost": cost,
        "outcome": pick(record.get("outcome"), ("status", "source", "success", "score")),
        "candidates": candidates,
    })
    if isinstance(record.get("adaptive_shadow"), dict):
        exported["adaptive_shadow"] = pick(
            record["adaptive_shadow"], ("policy", "threshold", "top2_gap", "would_trigger"),
        )
    if isinstance(record.get("adaptive_actual"), dict):
        exported["adaptive_actual"] = pick(record["adaptive_actual"], (
            "strategy", "stage1_winner_index", "stage1_top2_index", "stage1_gap",
            "escalation_triggered", "extra_comparisons", "final_winner_changed",
            "final_ranking_changed",
        ))
    return exported


def format_report(report: dict[str, Any], skipped: dict[str, int]) -> str:
    """Render a compact human-readable report without trajectory content."""
    def percent(value: Any) -> str:
        return "N/A" if value is None else f"{100 * value:.1f}%"

    winner = report["verifier_winner_success"]
    baseline = report["baseline_candidate_success"]
    uplift = report["paired_selection_uplift"]
    regret = report["regret"]
    uplift_text = ("N/A" if uplift["absolute_percentage_points"] is None
                   else f"{uplift['absolute_percentage_points']:+.1f} pp")
    regret_text = "N/A" if regret["mean"] is None else f"{regret['mean']:.4f}"
    lines = [
        f"Runs: {report['runs']}",
        f"Runs with ground truth: {report['runs_with_ground_truth']}",
        f"Skipped unsupported schema: {skipped['unsupported_schema']}",
        f"Skipped malformed lines: {skipped['malformed']}",
        "",
        f"Verifier winner success: {percent(winner['rate'])} (n={winner['sample_size']})",
        f"Baseline candidate success: {percent(baseline['rate'])} (n={baseline['sample_size']})",
        f"Selection uplift: {uplift_text} (paired n={uplift['sample_size']})",
        f"Mean regret: {regret_text} (n={regret['sample_size']})",
        "",
        "Cost totals / averages per run:",
    ]
    for field, values in report["cost"].items():
        average = values["average_per_run"]
        lines.append(f"  {field}: {values['total']:.0f} / {'N/A' if average is None else f'{average:.2f}'}")
    lines.extend(("", "Top-2 gap calibration:"))
    for bucket in report["gap_buckets"]:
        bucket_regret = ("N/A" if bucket["mean_regret"] is None
                         else f"{bucket['mean_regret']:.4f}")
        lines.append(
            f"  {bucket['bucket']}: runs={bucket['runs']}, outcome_n={bucket['runs_with_outcome']}, "
            f"winner_error={percent(bucket['winner_error_rate'])}, "
            f"mean_regret={bucket_regret}"
        )
    lines.extend(("", "Adaptive shadow policies (no escalation result inferred):"))
    for policy in report["shadow_policies"]:
        inside = policy["inside_escalated_set"]
        outside = policy["outside_escalated_set"]
        lines.append(
            f"  threshold={policy['threshold']:.3f}: trigger={policy['would_escalate']}/{policy['runs_with_gap']} "
            f"({percent(policy['escalation_rate'])}), errors inside/outside={inside['errors']}/{outside['errors']}"
        )
    actual = report["actual_adaptive"]
    lines.extend((
        "",
        f"Actual escalations: {actual['escalations']}; winner changes: {actual['winner_changes']}; "
        f"corrections: {actual['corrected_winners']}; harmful changes: {actual['harmful_winner_changes']}",
        "Extra reasoning tokens per correction: "
        + ("N/A" if actual["extra_reasoning_tokens_per_correction"] is None
           else f"{actual['extra_reasoning_tokens_per_correction']:.2f}"),
    ))
    return "\n".join(lines)
