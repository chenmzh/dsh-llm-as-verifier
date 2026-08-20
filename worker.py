"""Bounded JSON-lines bridge from DeepSeek Harness to ``llm_verifier``."""

from __future__ import annotations

import importlib
import json
import math
import os
import random
import re
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

VERIFIER_MODEL = "deepseek-v4-flash"
DEFAULT_VERIFIER_BASE_URL = "https://api.deepseek.com"
CAPABILITY_ERROR = (
    "Configured DSV4 verifier endpoint does not expose the token-level "
    "logprobs required by LLM-as-a-Verifier."
)
PROBE_INCONCLUSIVE = (
    "The DSV4 verifier capability probe did not establish whether the endpoint "
    "provides score-token logprobs."
)
DEFAULT_PROBE_MAX_TOKENS = 1024
DEFAULT_PROBE_RETRY_MAX_TOKENS = 2048
DEFAULT_SCORE_PREFILL_MAX_TOKENS = 2048
_CAPABILITY_PROBE_PROMPT = (
    "Evaluate this trivial candidate.\n"
    "Task: Return A.\n"
    "Candidate: A.\n"
    "End with exactly <score_A>A</score_A>."
)
_SCORE_A_PATTERN = re.compile(
    r"<score_A>\s*[A-T]\s*</score_A>",
    re.IGNORECASE,
)
_CACHE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class VerifierCapabilityError(RuntimeError):
    """Fine-grained score-position probabilities are unavailable."""

    def __init__(
        self,
        message: str,
        *,
        reason: str = "MALFORMED_LOGPROBS",
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.details = dict(details or {})


class VerifierProbeInconclusive(RuntimeError):
    """The bounded probe ended before verifier capability could be decided."""

    def __init__(
        self,
        message: str,
        *,
        reason: str,
        details: Mapping[str, Any],
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.details = dict(details)



class VerifierBudgetError(RuntimeError):
    """A verifier operation exceeds an explicit preflight budget."""

    def __init__(self, message: str, *, details: Mapping[str, Any]) -> None:
        super().__init__(message)
        self.details = dict(details)


_SCORE_LETTERS = frozenset("ABCDEFGHIJKLMNOPQRST")
_distribution_lock = threading.Lock()
_distribution_summaries: list[dict[str, Any]] = []
_score_context = threading.local()
_NO_TOP_LOGPROBS_TOKEN = "__DSH_NO_TOP_LOGPROBS__"
_EMPTY_TOP_LOGPROBS_TOKEN = "__DSH_EMPTY_TOP_LOGPROBS__"


def _normalize_score_token(token: Any) -> str | None:
    if not isinstance(token, str):
        return None
    normalized = token.strip()
    if normalized.startswith(">"):
        normalized = normalized[1:].strip()
    if len(normalized) != 1:
        return None
    letter = normalized.upper()
    return letter if letter in _SCORE_LETTERS else None


def _current_comparison() -> dict[str, Any] | None:
    record = getattr(_score_context, "record", None)
    return record if isinstance(record, dict) else None


def _probability(logprob: float) -> float | None:
    try:
        probability = math.exp(logprob)
    except OverflowError:
        return None
    return probability if math.isfinite(probability) else None


def _diagnostic_token(token: Any, limit: int = 120) -> str | None:
    if not isinstance(token, str):
        return None
    return token if len(token) <= limit else f"{token[:limit]}…"


def _diagnostic_alternatives(position: Any) -> list[dict[str, Any]]:
    alternatives = getattr(position, "top_logprobs", None) or []
    result = []
    for alternative in alternatives:
        token = getattr(alternative, "token", None)
        value = getattr(alternative, "logprob", None)
        numeric = (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        )
        sentinel_reason = (
            "no_top_logprobs"
            if token == _NO_TOP_LOGPROBS_TOKEN
            else "empty_top_logprobs" if token == _EMPTY_TOP_LOGPROBS_TOKEN
            else None
        )
        letter = _normalize_score_token(token)
        result.append({
            "token": _diagnostic_token(token),
            "logprob": float(value) if numeric else None,
            "normalized_letter": letter,
            "status": "candidate" if numeric and letter is not None else "discarded",
            "discard_reason": (
                None
                if numeric and letter is not None
                else sentinel_reason
                if sentinel_reason is not None
                else "malformed_logprob"
                if not numeric
                else "not_scale_token"
            ),
        })
    return result


def _score_position_diagnostics(choice: Any, tag: str) -> dict[str, Any]:
    positions = getattr(getattr(choice, "logprobs", None), "content", None) or []
    entries: list[dict[str, Any]] = []
    spans: list[tuple[int, int]] = []
    chosen_tokens: list[str] = []
    offset = 0
    for index, position in enumerate(positions):
        raw_token = getattr(position, "token", "")
        token = raw_token if isinstance(raw_token, str) else str(raw_token)
        chosen_tokens.append(token)
        start = offset
        offset += len(token)
        spans.append((start, offset))
        value = getattr(position, "logprob", None)
        numeric = (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        )
        entries.append({
            "position": index,
            "chosen_token": _diagnostic_token(token),
            "chosen_logprob": float(value) if numeric else None,
            "raw_top_logprobs": _diagnostic_alternatives(position),
        })
    message = getattr(choice, "message", None)
    raw_message_content = getattr(message, "content", "")
    message_content = raw_message_content if isinstance(raw_message_content, str) else ""

    joined = "".join(chosen_tokens)
    lower = joined.lower()
    lower_tag = tag.lower()
    tag_start = lower.rfind(lower_tag)
    tag_end = tag_start + len(tag) if tag_start >= 0 else -1
    closing = f"</{tag[1:]}"
    close_start = lower.find(closing.lower(), tag_end) if tag_end >= 0 else -1
    close_end = close_start + len(closing) if close_start >= 0 else -1
    payload_end = close_start if close_start >= 0 else tag_end

    def overlapping(start: int, end: int) -> list[int]:
        if start < 0 or end <= start:
            return []
        return [
            index
            for index, (span_start, span_end) in enumerate(spans)
            if span_start < end and span_end > start
        ]

    tag_positions = overlapping(tag_start, tag_end)
    payload_positions = overlapping(tag_end, payload_end)
    closing_positions = overlapping(close_start, close_end)
    focus = tag_positions + payload_positions + closing_positions
    if focus:
        window_start = max(0, min(focus) - 4)
        window_end = min(len(entries), max(focus) + 5)
        token_window = entries[window_start:window_end]
    else:
        token_window = entries[-9:]

    candidate_entries = [entries[index] for index in payload_positions]
    extractable = any(
        alternative["status"] == "candidate"
        for entry in candidate_entries
        for alternative in entry["raw_top_logprobs"]
    )
    tokenization = "POSITION_ALIGNMENT_UNKNOWN"
    if tag_positions and payload_positions:
        first_payload = payload_positions[0]
        payload_span_start, payload_span_end = spans[first_payload]
        payload_token = chosen_tokens[first_payload]
        payload_offset = max(0, tag_end - payload_span_start)
        prefix = payload_token[:payload_offset]
        if payload_span_start <= tag_start and payload_span_end > tag_end:
            tokenization = "TAG_AND_SCORE_FUSED"
        elif (
            prefix.strip() == ">"
            and lower[:payload_span_start].rstrip().endswith(lower_tag[:-1])
        ):
            tokenization = "TAG_SUFFIX_FUSED"
        elif close_start >= 0 and payload_span_end > close_start:
            tokenization = "SCORE_AND_CLOSING_TAG_FUSED"
        elif len(tag_positions) > 1:
            tokenization = "MULTI_TOKEN_TAG"
        elif len(payload_positions) == 1:
            tokenization = "SEPARATE_SCORE_TOKEN"
        if (
            not extractable
            and tokenization in ("SEPARATE_SCORE_TOKEN", "MULTI_TOKEN_TAG")
        ):
            tokenization = "TOP_LOGPROBS_MISSING_SCALE_ALTERNATIVES"

    if (
        tokenization == "POSITION_ALIGNMENT_UNKNOWN"
        and tag_start < 0
        and lower_tag in message_content.lower()
    ):
        tokenization = "INCOMPLETE_CHOSEN_TOKEN_STREAM"

    return {
        "chosen_score_text": (
            _diagnostic_token(joined[tag_end:payload_end])
            if tag_end >= 0 and payload_end >= tag_end
            else None
        ),
        "score_tokenization_class": tokenization,
        "score_position_candidates": candidate_entries,
        "token_window": token_window,
        "logprobs_present": bool(positions),
        "score_distribution_extractable": extractable,
        "chosen_token_text_length": len(joined),
        "message_content_length": len(message_content),
        "chosen_token_text_matches_message": joined == message_content,
    }


def _record_distribution(
    tag: str,
    raw_alternatives: list[dict[str, Any]],
    logprobs: Mapping[str, float],
    expected_reward: float,
) -> None:
    maximum = max(logprobs.values())
    weights = {letter: math.exp(value - maximum) for letter, value in logprobs.items()}
    total = sum(weights.values())
    normalized = [
        {"letter": letter, "probability": weights[letter] / total}
        for letter in sorted(weights)
    ]
    retained_mass = sum(
        alternative["probability"]
        for alternative in raw_alternatives
        if alternative.get("retained") is True
        and isinstance(alternative.get("probability"), (int, float))
    )
    discarded_mass = sum(
        alternative["probability"]
        for alternative in raw_alternatives
        if alternative.get("retained") is False
        and isinstance(alternative.get("probability"), (int, float))
    )
    mapped_count = sum(
        1
        for alternative in raw_alternatives
        if alternative.get("normalized_letter") is not None
    )
    summary = {
        "raw_alternative_count": len(raw_alternatives),
        "mapped_scale_token_count": mapped_count,
        "unique_scale_letter_count": len(logprobs),
        "discarded_alternative_count": len(raw_alternatives) - len(logprobs),
        # This mass uses the same highest-logprob form per scale letter as the
        # expected reward, so forms such as A and >A do not contribute twice.
        "scale_mass": retained_mass,
        "position": tag,
        "raw_alternatives": raw_alternatives,
        "normalized_scale": normalized,
        "retained_probability_mass": retained_mass,
        "discarded_probability_mass": discarded_mass,
        "expected_reward": expected_reward,
    }
    comparison = _current_comparison()
    if comparison is not None:
        request = next(
            (
                item
                for item in reversed(comparison.get("requests", []))
                if item.get("kind") == tag.strip("<>").lower()
            ),
            None,
        )
        if request is not None:
            summary["chosen_token"] = request.get("chosen_token")
            summary["finish_reason"] = request.get("finish_reason")
        comparison["score_a" if tag == "<score_A>" else "score_b"] = summary
        return
    with _distribution_lock:
        _distribution_summaries.append(summary)


def _score_failure(
    tag: str,
    reason: str,
    raw_alternatives: list[dict[str, Any]],
) -> VerifierCapabilityError:
    summary = {
        "position": tag,
        "raw_alternatives": raw_alternatives,
        "normalized_scale": [],
        "raw_alternative_count": len(raw_alternatives),
        "mapped_scale_token_count": sum(
            1
            for alternative in raw_alternatives
            if alternative.get("normalized_letter") is not None
        ),
        "unique_scale_letter_count": 0,
        "discarded_alternative_count": len(raw_alternatives),
        "scale_mass": 0.0,
        "retained_probability_mass": 0.0,
        "discarded_probability_mass": sum(
            alternative["probability"]
            for alternative in raw_alternatives
            if isinstance(alternative.get("probability"), (int, float))
        ),
        "failure_reason": reason,
    }
    comparison = _current_comparison()
    details: dict[str, Any] = {
        "failure_reason": reason,
        "score_position": tag,
        "distribution": summary,
    }
    if comparison is not None:
        comparison["score_a" if tag == "<score_A>" else "score_b"] = summary
        details["comparison"] = comparison
    return VerifierCapabilityError(
        f"{CAPABILITY_ERROR} Missing usable A-T probabilities at {tag} "
        f"({reason}).",
        reason=reason,
        details=details,
    )


def _expected_score(
    alternatives: Any,
    tag: str,
    *,
    progress: bool,
    missing_reason: str = "NO_TOP_LOGPROBS",
) -> float:
    logprobs: dict[str, float] = {}
    raw_alternatives: list[dict[str, Any]] = []
    saw_well_formed = False
    saw_non_sentinel = False
    sentinel_reason: str | None = None
    for alternative in alternatives or []:
        if not isinstance(alternative, (list, tuple)) or len(alternative) != 2:
            raw_alternatives.append({
                "token": None,
                "logprob": None,
                "probability": None,
                "normalized_letter": None,
                "retained": False,
                "malformed": True,
                "discard_reason": "malformed_alternative",
            })
            continue
        token = alternative[0]
        value = alternative[1]
        if token == _NO_TOP_LOGPROBS_TOKEN:
            sentinel_reason = "NO_TOP_LOGPROBS"
            continue
        if token == _EMPTY_TOP_LOGPROBS_TOKEN:
            sentinel_reason = "EMPTY_TOP_LOGPROBS"
            continue
        saw_non_sentinel = True
        letter = _normalize_score_token(token)
        numeric = (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        )
        probability = _probability(float(value)) if numeric else None
        raw = {
            "token": token if isinstance(token, str) else None,
            "logprob": float(value) if numeric else None,
            "probability": probability,
            "normalized_letter": letter,
            "retained": False,
            "malformed": not numeric,
            "discard_reason": None,
        }
        raw_alternatives.append(raw)
        if not numeric:
            raw["discard_reason"] = "malformed_logprob"
            continue
        saw_well_formed = True
        if letter is None:
            raw["discard_reason"] = "not_scale_token"
            continue
        previous = logprobs.get(letter, float("-inf"))
        if float(value) > previous:
            for prior in raw_alternatives[:-1]:
                if prior.get("normalized_letter") == letter:
                    prior["retained"] = False
                    prior["discard_reason"] = "duplicate_lower_probability"
            raw["retained"] = True
            raw["discard_reason"] = None
            logprobs[letter] = float(value)
        else:
            raw["discard_reason"] = "duplicate_lower_probability"
    if not logprobs:
        reason = sentinel_reason or missing_reason
        if saw_non_sentinel:
            reason = "NO_VALID_SCALE_TOKEN" if saw_well_formed else "MALFORMED_LOGPROBS"
        raise _score_failure(tag, reason, raw_alternatives)
    maximum = max(logprobs.values())
    weights = {letter: math.exp(value - maximum) for letter, value in logprobs.items()}
    total = sum(weights.values())
    if not math.isfinite(total) or total <= 0:
        raise _score_failure(tag, "MALFORMED_LOGPROBS", raw_alternatives)
    expected_index = sum((_score_index(letter) * weight) for letter, weight in weights.items()) / total
    normalized = expected_index / (len(_SCORE_LETTERS) - 1)
    expected_reward = normalized if progress else 1 - normalized
    _record_distribution(tag, raw_alternatives, logprobs, expected_reward)
    return expected_reward


def _score_index(letter: str) -> int:
    return ord(letter) - ord("A")


def _find_tag_logprobs(tokens: Any, position_logprobs: Any, tag: str) -> tuple[Any, str]:
    if not tokens:
        return None, "NO_SCORE_POSITION"
    if not position_logprobs:
        return None, "NO_TOP_LOGPROBS"
    for suffix in (tag, tag[:-1]):
        found = None
        text_so_far = ""
        for index, token in enumerate(tokens):
            text_so_far += str(token)
            if text_so_far.rstrip().endswith(suffix) and index + 1 < len(position_logprobs):
                found = position_logprobs[index + 1]
        if found is not None:
            if not found:
                return found, "EMPTY_TOP_LOGPROBS"
            return found, "NO_TOP_LOGPROBS"
    return None, "NO_SCORE_POSITION"


def _strict_extract_score(
    _text: Any,
    tokens: Any,
    position_logprobs: Any,
    tag: str,
) -> float:
    alternatives, missing_reason = _find_tag_logprobs(tokens, position_logprobs, tag)
    return _expected_score(
        alternatives,
        tag,
        progress=False,
        missing_reason=missing_reason,
    )


def _checkpoint_logprobs(
    tokens: Any,
    position_logprobs: Any,
    tag: str,
) -> tuple[Any, str]:
    if not tokens:
        return None, "NO_SCORE_POSITION"
    if not position_logprobs:
        return None, "NO_TOP_LOGPROBS"
    joined = ""
    positions: list[tuple[int, int]] = []
    for index, token in enumerate(tokens):
        joined += str(token)
        positions.append((len(joined), index))
    tag_start = joined.rfind(tag)
    if tag_start < 0:
        return None, "NO_SCORE_POSITION"
    target = tag_start + len(tag)
    for end, index in positions:
        if end > target and index < len(position_logprobs):
            alternatives = position_logprobs[index]
            return (
                alternatives,
                "EMPTY_TOP_LOGPROBS" if not alternatives else "NO_TOP_LOGPROBS",
            )
    return None, "NO_TOP_LOGPROBS"


def _strict_extract_progress_scores(
    _text: Any,
    tokens: Any,
    position_logprobs: Any,
    count: int,
) -> list[float]:
    scores = []
    for index in range(1, count + 1):
        tag = f"<c{index}>"
        alternatives, missing_reason = _checkpoint_logprobs(
            tokens,
            position_logprobs,
            tag,
        )
        scores.append(_expected_score(
            alternatives,
            tag,
            progress=True,
            missing_reason=missing_reason,
        ))
    return scores


class _MissingTopLogprobs:
    token = _NO_TOP_LOGPROBS_TOKEN
    logprob = 0.0


class _EmptyTopLogprobs:
    token = _EMPTY_TOP_LOGPROBS_TOKEN
    logprob = 0.0


class _PositionLogprobs:
    def __init__(self, position: Any) -> None:
        self.token = position.token
        self.logprob = position.logprob
        marker = object()
        alternatives = getattr(position, "top_logprobs", marker)
        if alternatives is marker or alternatives is None:
            self.top_logprobs = [_MissingTopLogprobs()]
        elif not alternatives:
            self.top_logprobs = [_EmptyTopLogprobs()]
        else:
            self.top_logprobs = alternatives


class _ChoiceLogprobs:
    def __init__(self, logprobs: Any) -> None:
        self.content = [
            _PositionLogprobs(position)
            for position in (getattr(logprobs, "content", None) or [])
        ]


class _VerifierChoice:
    def __init__(self, choice: Any) -> None:
        self._choice = choice
        raw_logprobs = getattr(choice, "logprobs", None)
        self.logprobs = None if raw_logprobs is None else _ChoiceLogprobs(raw_logprobs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._choice, name)


class _VerifierResponse:
    def __init__(self, response: Any) -> None:
        self._response = response
        self.choices = [_VerifierChoice(choice) for choice in response.choices]

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)


def _is_score_prefill_request(kwargs: Mapping[str, Any]) -> bool:
    extra_body = kwargs.get("extra_body")
    return (
        isinstance(extra_body, Mapping)
        and extra_body.get("continue_final_message") is True
    )


def _request_kind(kwargs: Mapping[str, Any]) -> str:
    if not _is_score_prefill_request(kwargs):
        return "analysis"
    messages = kwargs.get("messages")
    if isinstance(messages, list) and messages:
        last = messages[-1]
        if isinstance(last, Mapping):
            content = last.get("content")
            if isinstance(content, str):
                for tag in ("<score_A>", "<score_B>"):
                    if content.rstrip().endswith(tag):
                        return tag.strip("<>").lower()
    return "score_prefill"


def _response_request_record(
    response: Any,
    kind: str,
    latency_ms: float,
) -> dict[str, Any]:
    choices = getattr(response, "choices", None) or []
    choice = choices[0] if choices else None
    message = getattr(choice, "message", None)
    content = getattr(message, "content", None)
    usage = getattr(response, "usage", None)
    prompt_details = getattr(usage, "prompt_tokens_details", None)
    completion_details = getattr(usage, "completion_tokens_details", None)
    cached = _usage_value(prompt_details, "cached_tokens")
    if cached == 0:
        cached = _usage_value(usage, "prompt_cache_hit_tokens")
    raw_logprobs = getattr(choice, "logprobs", None)
    positions = getattr(raw_logprobs, "content", None)
    if not positions:
        logprobs_state = "NO_TOP_LOGPROBS"
    else:
        top = getattr(positions[0], "top_logprobs", None)
        logprobs_state = (
            "NO_TOP_LOGPROBS"
            if top is None
            else "EMPTY_TOP_LOGPROBS" if not top else "PRESENT"
        )
    return {
        "kind": kind,
        "finish_reason": getattr(choice, "finish_reason", None),
        "chosen_token": (
            content[:80]
            if kind in ("score_a", "score_b") and isinstance(content, str)
            else None
        ),
        "logprobs_state": logprobs_state,
        "input_tokens": _usage_value(usage, "prompt_tokens"),
        "cached_input_tokens": cached,
        "output_tokens": _usage_value(usage, "completion_tokens"),
        "reasoning_tokens": _usage_value(completion_details, "reasoning_tokens"),
        "latency_ms": round(latency_ms, 3),
    }


class _VerifierCompletions:
    def __init__(
        self,
        completions: Any,
        native_deepseek: bool,
        policy: "_VerifierRequestPolicy",
    ) -> None:
        self._completions = completions
        self._native_deepseek = native_deepseek
        self._policy = policy

    def create(self, *args: Any, **kwargs: Any) -> Any:
        if _is_score_prefill_request(kwargs):
            kwargs["max_tokens"] = _positive_probe_budget(
                "VERIFIER_SCORE_PREFILL_MAX_TOKENS",
                DEFAULT_SCORE_PREFILL_MAX_TOKENS,
            )
        kwargs["model"] = VERIFIER_MODEL
        kwargs["logprobs"] = True
        kwargs["top_logprobs"] = 20
        if self._native_deepseek:
            extra_body = dict(kwargs.get("extra_body") or {})
            extra_body.pop("thinking", None)
            extra_body.pop("reasoning_effort", None)
            effort = self._policy.reasoning_effort
            if effort == "off":
                extra_body["thinking"] = {"type": "disabled"}
            else:
                extra_body["thinking"] = {"type": "enabled"}
                extra_body["reasoning_effort"] = effort
            kwargs["extra_body"] = extra_body
        kind = _request_kind(kwargs)
        started = time.perf_counter()
        try:
            response = self._completions.create(*args, **kwargs)
        except Exception:
            comparison = _current_comparison()
            if comparison is not None:
                comparison.setdefault("requests", []).append({
                    "kind": kind,
                    "failure_reason": "REQUEST_FAILED",
                    "latency_ms": round(
                        (time.perf_counter() - started) * 1000,
                        3,
                    ),
                })
            raise
        comparison = _current_comparison()
        if comparison is not None:
            comparison.setdefault("requests", []).append(_response_request_record(
                response,
                kind,
                (time.perf_counter() - started) * 1000,
            ))
        return _VerifierResponse(response)


class _VerifierChat:
    def __init__(
        self,
        chat: Any,
        native_deepseek: bool,
        policy: "_VerifierRequestPolicy",
    ) -> None:
        self.completions = _VerifierCompletions(
            chat.completions,
            native_deepseek,
            policy,
        )


class _VerifierRequestPolicy:
    def __init__(self) -> None:
        self.reasoning_effort = "high"
        self._operation_lock = threading.RLock()

    @contextmanager
    def use(self, reasoning_effort: str) -> Any:
        if reasoning_effort not in ("off", "low", "high"):
            raise ValueError("reasoning_effort must be off, low, or high")
        with self._operation_lock:
            previous = self.reasoning_effort
            self.reasoning_effort = reasoning_effort
            try:
                yield
            finally:
                self.reasoning_effort = previous


class _VerifierClient:
    def __init__(self, client: Any, native_deepseek: bool) -> None:
        self._request_policy = _VerifierRequestPolicy()
        self.chat = _VerifierChat(client.chat, native_deepseek, self._request_policy)
        self._llm_verifier_model = VERIFIER_MODEL
        self._llm_verifier_deepseek = native_deepseek

    def request_policy(self, reasoning_effort: str) -> Any:
        return self._request_policy.use(reasoning_effort)


_verifier_client: Any = None


def _transport(base_url: str) -> str:
    configured = os.environ.get("VERIFIER_TRANSPORT")
    if configured is None:
        normalized = base_url.lower().rstrip("/")
        configured = (
            "deepseek-native"
            if normalized in (DEFAULT_VERIFIER_BASE_URL, f"{DEFAULT_VERIFIER_BASE_URL}/v1")
            else "openai-compatible"
        )
    if configured not in ("deepseek-native", "openai-compatible"):
        raise RuntimeError(
            "VERIFIER_TRANSPORT must be deepseek-native or openai-compatible"
        )
    return configured


def _client() -> Any:
    global _verifier_client
    if _verifier_client is not None:
        return _verifier_client
    base_url = os.environ.get("VERIFIER_BASE_URL", DEFAULT_VERIFIER_BASE_URL)
    api_key = os.environ.get("VERIFIER_API_KEY")
    if not api_key and base_url.rstrip("/") == DEFAULT_VERIFIER_BASE_URL:
        raise RuntimeError(
            "VERIFIER_API_KEY is required for the official DeepSeek verifier endpoint"
        )
    reward = importlib.import_module("llm_verifier.fine_grained_reward")
    client = reward.create_openai_client(base_url=base_url, api_key=api_key or "EMPTY")
    _verifier_client = _VerifierClient(client, _transport(base_url) == "deepseek-native")
    return _verifier_client


_capability_lock = threading.Lock()
_capability_results: dict[tuple[Any, ...], dict[str, Any]] = {}


def _positive_probe_budget(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer") from error
    if value < 1:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


def _probe_budgets() -> tuple[int, int]:
    initial = _positive_probe_budget(
        "VERIFIER_PROBE_MAX_TOKENS",
        DEFAULT_PROBE_MAX_TOKENS,
    )
    retry = _positive_probe_budget(
        "VERIFIER_PROBE_RETRY_MAX_TOKENS",
        DEFAULT_PROBE_RETRY_MAX_TOKENS,
    )
    if retry <= initial:
        raise RuntimeError(
            "VERIFIER_PROBE_RETRY_MAX_TOKENS must exceed VERIFIER_PROBE_MAX_TOKENS"
        )
    return initial, retry


def _usage_value(owner: Any, name: str) -> int:
    value = getattr(owner, name, 0)
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _probe_diagnostics(
    response: Any,
    *,
    max_tokens: int,
    attempt: int,
    failure_reason: str,
) -> dict[str, Any]:
    choices = getattr(response, "choices", None) or []
    choice = choices[0] if choices else None
    message = getattr(choice, "message", None)
    content = getattr(message, "content", "")
    text = content if isinstance(content, str) else ""
    raw_logprobs = getattr(choice, "logprobs", None)
    positions = getattr(raw_logprobs, "content", None) or []
    usage = getattr(response, "usage", None)
    prompt_details = getattr(usage, "prompt_tokens_details", None)
    completion_details = getattr(usage, "completion_tokens_details", None)
    cached = _usage_value(prompt_details, "cached_tokens")
    if cached == 0:
        cached = _usage_value(usage, "prompt_cache_hit_tokens")
    return {
        "model": str(getattr(response, "model", None) or VERIFIER_MODEL),
        "finish_reason": getattr(choice, "finish_reason", None),
        "input_tokens": _usage_value(usage, "prompt_tokens"),
        "cached_input_tokens": cached,
        "output_tokens": _usage_value(usage, "completion_tokens"),
        "reasoning_tokens": _usage_value(completion_details, "reasoning_tokens"),
        "logprobs_present": bool(positions),
        "score_token_present": _SCORE_A_PATTERN.search(text) is not None,
        "failure_reason": failure_reason,
        "probe_attempt": attempt,
        "probe_max_tokens": max_tokens,
    }


def _probe_token_data(choice: Any) -> tuple[list[str], list[list[tuple[Any, Any]]]]:
    content = getattr(getattr(choice, "logprobs", None), "content", None) or []
    tokens: list[str] = []
    position_logprobs: list[list[tuple[Any, Any]]] = []
    for position in content:
        tokens.append(str(getattr(position, "token", "")))
        position_logprobs.append([
            (getattr(alternative, "token", None), getattr(alternative, "logprob", None))
            for alternative in (getattr(position, "top_logprobs", None) or [])
        ])
    return tokens, position_logprobs


def _classify_probe_response(
    response: Any,
    *,
    max_tokens: int,
    attempt: int,
) -> dict[str, Any]:
    details = _probe_diagnostics(
        response,
        max_tokens=max_tokens,
        attempt=attempt,
        failure_reason="REQUEST_FAILED",
    )
    choices = getattr(response, "choices", None) or []
    if not choices:
        raise VerifierProbeInconclusive(
            f"{PROBE_INCONCLUSIVE} The endpoint returned no completion choice.",
            reason="REQUEST_FAILED",
            details=details,
        )

    choice = choices[0]
    message = getattr(choice, "message", None)
    content = getattr(message, "content", "")
    score_evidence = _score_position_diagnostics(choice, "<score_A>")
    details["score_evidence"] = score_evidence
    text = content if isinstance(content, str) else ""
    output_tokens = details["output_tokens"]
    reasoning_tokens = details["reasoning_tokens"]
    reasoning_exhausted = (
        details["finish_reason"] == "length"
        and not text.strip()
        and not details["score_token_present"]
        and isinstance(output_tokens, int)
        and output_tokens > 0
        and isinstance(reasoning_tokens, int)
        and reasoning_tokens / output_tokens >= 0.9
    )
    if reasoning_exhausted:
        details["failure_reason"] = "OUTPUT_BUDGET_EXHAUSTED"
        raise VerifierProbeInconclusive(
            f"{PROBE_INCONCLUSIVE} The probe exhausted its {max_tokens}-token "
            "output budget during DSV4 reasoning before score tokens were emitted. "
            "This does not prove that the endpoint lacks logprob support.",
            reason="OUTPUT_BUDGET_EXHAUSTED",
            details=details,
        )
    if details["finish_reason"] != "stop":
        raise VerifierProbeInconclusive(
            f"{PROBE_INCONCLUSIVE} The endpoint did not complete the probe normally "
            f"(finish_reason={details['finish_reason']!r}).",
            reason="REQUEST_FAILED",
            details=details,
        )
    if not details["score_token_present"]:
        details["failure_reason"] = "NO_SCORE_TOKEN"
        raise VerifierProbeInconclusive(
            f"{PROBE_INCONCLUSIVE} The completed response did not contain the "
            "required <score_A> A-T score token.",
            reason="NO_SCORE_TOKEN",
            details=details,
        )
    if not details["logprobs_present"]:
        details["failure_reason"] = "LOGPROBS_UNAVAILABLE"
        raise VerifierCapabilityError(
            f"{CAPABILITY_ERROR} The completed probe emitted <score_A> but returned "
            "no token-level logprobs.",
            reason="LOGPROBS_UNAVAILABLE",
            details=details,
        )

    tokens, position_logprobs = _probe_token_data(choice)
    with _distribution_lock:
        summary_count = len(_distribution_summaries)
    try:
        _strict_extract_score(text, tokens, position_logprobs, "<score_A>")
    except VerifierCapabilityError as error:
        details["failure_reason"] = error.reason
        score_evidence["extraction"] = dict(error.details)
        raise VerifierCapabilityError(
            f"{CAPABILITY_ERROR} The completed probe returned unusable "
            "score-position logprobs at <score_A>.",
            reason=error.reason,
            details=details,
        ) from error
    with _distribution_lock:
        if len(_distribution_summaries) > summary_count:
            score_evidence["distribution"] = dict(_distribution_summaries[-1])
    score_evidence["score_distribution_extractable"] = True
    details["failure_reason"] = "SUPPORTED"
    return details


def _probe_capability(module: Any, max_tokens: int, attempt: int) -> dict[str, Any]:
    client = _client()
    kwargs: dict[str, Any] = {
        "model": VERIFIER_MODEL,
        "messages": [{"role": "user", "content": _CAPABILITY_PROBE_PROMPT}],
        "max_tokens": max_tokens,
        "temperature": 1.0,
        "logprobs": True,
        "top_logprobs": 20,
    }
    reward = importlib.import_module("llm_verifier.fine_grained_reward")
    if getattr(client, "_llm_verifier_deepseek", False):
        extra_body, _ = reward.deepseek_reasoning_params()
        kwargs["extra_body"] = extra_body
    try:
        response = client.chat.completions.create(**kwargs)
    except Exception as error:
        details = {
            "model": VERIFIER_MODEL,
            "finish_reason": None,
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "logprobs_present": False,
            "score_token_present": False,
            "failure_reason": "REQUEST_FAILED",
            "probe_attempt": attempt,
            "probe_max_tokens": max_tokens,
        }
        raise VerifierProbeInconclusive(
            f"{PROBE_INCONCLUSIVE} The capability request failed: {error}",
            reason="REQUEST_FAILED",
            details=details,
        ) from error
    usage_counter = getattr(reward, "USAGE", None)
    record_usage = getattr(usage_counter, "record", None)
    if callable(record_usage):
        record_usage(response)
    return _classify_probe_response(
        response,
        max_tokens=max_tokens,
        attempt=attempt,
    )


def _capability_key(budgets: tuple[int, int]) -> tuple[Any, ...]:
    base_url = os.environ.get("VERIFIER_BASE_URL", DEFAULT_VERIFIER_BASE_URL)
    return (
        _safe_endpoint_identifier(base_url),
        VERIFIER_MODEL,
        _transport(base_url),
        True,
        20,
        budgets,
    )



def _safe_endpoint_identifier(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if not parsed.scheme or parsed.hostname is None:
        return "configured-verifier-endpoint"
    host = parsed.hostname
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path.rstrip("/"), "", ""))


def _ensure_capability(module: Any) -> dict[str, Any]:
    budgets = _probe_budgets()
    key = _capability_key(budgets)
    with _capability_lock:
        cached = _capability_results.get(key)
        if cached is not None:
            result = dict(cached)
            result["cache_hit"] = True
            return result
        for attempt, max_tokens in enumerate(budgets, start=1):
            try:
                result = _probe_capability(module, max_tokens, attempt)
            except VerifierProbeInconclusive as error:
                if (
                    error.reason == "OUTPUT_BUDGET_EXHAUSTED"
                    and attempt < len(budgets)
                ):
                    continue
                if error.reason == "OUTPUT_BUDGET_EXHAUSTED":
                    details = dict(error.details)
                    details["probe_budgets"] = list(budgets)
                    raise VerifierProbeInconclusive(
                        f"{PROBE_INCONCLUSIVE} DSV4 reasoning exhausted both bounded "
                        f"probe budgets ({budgets[0]} and {budgets[1]} tokens) before "
                        "score tokens were emitted. Retry with larger verifier probe "
                        "budgets or explicitly supported lower reasoning effort.",
                        reason=error.reason,
                        details=details,
                    ) from error
                raise
            cached_result = dict(result)
            _capability_results[key] = cached_result
            result = dict(cached_result)
            result["cache_hit"] = False
            return result
    raise AssertionError("capability probe loop did not return")

_TRACKER_LIMIT = 128
_TRACKER_TTL_SECONDS = 3600.0
_trackers: dict[str, tuple[tuple[Any, ...], Any, float]] = {}


def _prune_trackers(now: float, incoming_id: str) -> None:
    expired = [
        tracker_id
        for tracker_id, (_, _, updated_at) in _trackers.items()
        if now - updated_at >= _TRACKER_TTL_SECONDS
    ]
    for tracker_id in expired:
        _trackers.pop(tracker_id, None)
    while len(_trackers) >= _TRACKER_LIMIT and incoming_id not in _trackers:
        oldest = min(_trackers, key=lambda item: _trackers[item][2])
        _trackers.pop(oldest, None)


def _module() -> Any:
    module = importlib.import_module("llm_verifier")
    reward = importlib.import_module("llm_verifier.fine_grained_reward")
    progress = importlib.import_module("llm_verifier.progress")
    reward.extract_score = _strict_extract_score
    progress.extract_progress_scores = _strict_extract_progress_scores
    return module


def _usage_snapshot(module: Any) -> dict[str, int]:
    raw = module.token_usage()
    if isinstance(raw, Mapping):
        source = raw
    else:
        source = vars(raw)
    return {
        "calls": int(source.get("calls", 0)),
        "input_tokens": int(source.get("input_tokens", 0)),
        "cached_input_tokens": int(source.get("cached_input_tokens", 0)),
        "output_tokens": int(source.get("output_tokens", 0)),
        "reasoning_tokens": int(source.get("reasoning_tokens", 0)),
    }


def _usage_delta(before: Mapping[str, int], after: Mapping[str, int]) -> dict[str, int]:
    return {key: max(0, after[key] - before[key]) for key in before}


def _planned_work(module: Any, request: Mapping[str, Any]) -> dict[str, Any]:
    operation = str(request["operation"])
    criteria = request.get("criteria")
    criteria_count = len(criteria) if isinstance(criteria, Mapping) else 0
    n_evaluations = int(request.get("n_evaluations", 1))
    candidate_count = (
        len(request.get("candidates", []))
        if operation in ("select", "select_escalation")
        else 2 if operation == "compare"
        else 1
    )
    planned_comparisons = 0
    if operation == "compare":
        planned_comparisons = 1
    elif operation == "select" and candidate_count > 1:
        ring = list(module.ppt.ring_cycle(candidate_count, random.Random(0)))
        pivot_count = min(int(request["pivots"]), candidate_count)
        placeholder_pivots = list(range(pivot_count))
        pivot_pairs = list(
            module.ppt.pivot_round_pairs(candidate_count, placeholder_pivots)
        )
        planned_comparisons = len(ring) + len(pivot_pairs)
    elif operation == "select_escalation":
        adaptive_pairs = request.get("adaptive_pairs")
        if not isinstance(adaptive_pairs, list):
            raise ValueError("select_escalation requires adaptive_pairs")
        planned_comparisons = len(adaptive_pairs)

    comparison_jobs = planned_comparisons * max(1, criteria_count) * n_evaluations
    if operation in ("compare", "select", "select_escalation"):
        requests_per_job = (
            1
            if _transport(os.environ.get(
                "VERIFIER_BASE_URL", DEFAULT_VERIFIER_BASE_URL
            )) == "deepseek-native"
            else 3
        )
        planned_calls = comparison_jobs * requests_per_job
    elif operation in ("score", "progress"):
        planned_calls = n_evaluations
    else:
        planned_calls = 0
    return {
        "planned_comparisons": planned_comparisons,
        "planned_verifier_calls": planned_calls,
        "planned_call_basis": "no_selection_cache",
        "candidate_count": candidate_count,
        "criteria_count": criteria_count,
        "n_evaluations": n_evaluations,
        "max_workers": int(request.get("max_workers") or module.default_max_workers()),
    }


def _enforce_operation_budget(
    request: Mapping[str, Any],
    planned: Mapping[str, Any],
) -> None:
    max_calls = request.get("max_calls_per_operation")
    max_comparisons = request.get("max_comparisons")
    if max_calls is not None and planned["planned_verifier_calls"] > int(max_calls):
        raise VerifierBudgetError(
            "Verifier operation exceeds budget.maxCallsPerOperation",
            details={**planned, "failure_reason": "MAX_CALLS_PER_OPERATION"},
        )
    if (
        max_comparisons is not None
        and planned["planned_comparisons"] > int(max_comparisons)
    ):
        raise VerifierBudgetError(
            "Verifier operation exceeds budget.maxComparisons",
            details={**planned, "failure_reason": "MAX_COMPARISONS"},
        )


def _operation_telemetry(
    request: Mapping[str, Any],
    value: Mapping[str, Any],
    planned: Mapping[str, Any],
    usage: Mapping[str, int],
    latency_ms: float,
    capability_probe: Mapping[str, Any] | None,
) -> dict[str, Any]:
    operation = str(request["operation"])
    details = value.get("details")
    details_map = details if isinstance(details, Mapping) else {}
    actual_comparisons = (
        int(details_map.get("n_comparisons", 0))
        if operation in ("select", "select_escalation")
        else 1 if operation == "compare"
        else 0
    )
    input_tokens = int(usage["input_tokens"])
    cached_tokens = int(usage["cached_input_tokens"])
    telemetry = {
        "operation": operation,
        "model": VERIFIER_MODEL,
        "endpoint": _safe_endpoint_identifier(os.environ.get(
            "VERIFIER_BASE_URL", DEFAULT_VERIFIER_BASE_URL
        )),
        **planned,
        "pivots": (
            int(request["pivots"])
            if operation in ("select", "select_escalation")
            else None
        ),
        "comparisons": actual_comparisons,
        "verifier_calls": int(usage["calls"]),
        "max_workers": int(planned["max_workers"]),
        "reasoning_effort": str(request.get("reasoning_effort", "high")),
        "latency_ms": round(latency_ms, 3),
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_tokens,
        "uncached_input_tokens": max(0, input_tokens - cached_tokens),
        "output_tokens": int(usage["output_tokens"]),
        "reasoning_tokens": int(usage["reasoning_tokens"]),
        "cache_hit_rate": (cached_tokens / input_tokens if input_tokens else 0.0),
    }
    if operation in ("select", "select_escalation"):
        telemetry.update({
            "selected_index": value.get("selected_index"),
            "ranking": value.get("ranking"),
            "candidate_scores": value.get("scores"),
        })
    if capability_probe is not None:
        telemetry["capability_probe"] = dict(capability_probe)
    return telemetry


def _common(request: Mapping[str, Any]) -> dict[str, Any]:
    common: dict[str, Any] = {
        "model": VERIFIER_MODEL,
        "client": _client(),
        "n_evaluations": request["n_evaluations"],
    }
    max_workers = request.get("max_workers")
    if max_workers is not None:
        common["max_workers"] = max_workers
    return common


def _selection_cache_path(cache_id: Any) -> str:
    if not isinstance(cache_id, str) or _CACHE_ID_PATTERN.fullmatch(cache_id) is None:
        raise ValueError("cache_id must contain only bounded identifier characters")
    return os.path.join(tempfile.gettempdir(), f"dsh-verifier-{cache_id}.json")


def _comparison_key(
    phase: str,
    pair_index: int,
    candidate_a: int,
    candidate_b: int,
    criterion_id: str,
    repetition: int,
) -> str:
    return json.dumps(
        [phase, pair_index, candidate_a, candidate_b, criterion_id, repetition],
        separators=(",", ":"),
    )


def _load_selection_cache(path: str | None) -> dict[str, Any]:
    if path is None or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as source:
        payload = json.load(source)
    if (
        not isinstance(payload, dict)
        or payload.get("version") != 1
        or not isinstance(payload.get("entries"), dict)
    ):
        raise RuntimeError("verifier selection cache has an unsupported format")
    return dict(payload["entries"])


def _save_selection_cache(path: str | None, entries: Mapping[str, Any]) -> None:
    if path is None:
        return
    with open(path, "w", encoding="utf-8") as target:
        json.dump(
            {"version": 1, "entries": entries},
            target,
            separators=(",", ":"),
        )


def _comparison_jobs(
    phase: str,
    pairs: list[tuple[int, int]],
    criteria: list[Mapping[str, Any]],
    n_evaluations: int,
) -> list[dict[str, Any]]:
    jobs = []
    for pair_index, (candidate_a, candidate_b) in enumerate(pairs):
        for criterion_index, criterion in enumerate(criteria):
            criterion_id = str(criterion["id"])
            for repetition in range(n_evaluations):
                swap = repetition % 2 == 1
                slot_a, slot_b = (
                    (candidate_b, candidate_a)
                    if swap
                    else (candidate_a, candidate_b)
                )
                jobs.append({
                    "key": _comparison_key(
                        phase,
                        pair_index,
                        candidate_a,
                        candidate_b,
                        criterion_id,
                        repetition,
                    ),
                    "comparison_id": (
                        f"{phase}-{pair_index}-c{criterion_index}-r{repetition}"
                    ),
                    "pair_id": f"{phase}-{pair_index}",
                    "phase": phase,
                    "pair_index": pair_index,
                    "candidate_a": candidate_a,
                    "candidate_b": candidate_b,
                    "slot_a": slot_a,
                    "slot_b": slot_b,
                    "criterion": criterion,
                    "criterion_index": criterion_index,
                    "repetition": repetition,
                    "swap": swap,
                })
    return jobs


def _summed_request_usage(requests: list[Mapping[str, Any]]) -> dict[str, int]:
    fields = (
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_tokens",
    )
    return {
        "calls": len(requests),
        **{
            field: sum(
                int(request.get(field, 0))
                for request in requests
                if isinstance(request.get(field, 0), (int, float))
                and not isinstance(request.get(field, 0), bool)
            )
            for field in fields
        },
    }


def _score_comparison_job(
    module: Any,
    client: Any,
    problem: str,
    candidates: list[str],
    ground_truth_note: str,
    job: Mapping[str, Any],
) -> tuple[str, dict[str, Any]]:
    criterion = job["criterion"]
    record: dict[str, Any] = {
        "comparison_id": job["comparison_id"],
        "pair_id": job["pair_id"],
        "phase": job["phase"],
        "pair_index": job["pair_index"],
        "candidate_a": job["candidate_a"],
        "candidate_b": job["candidate_b"],
        "slot_order": {
            "slot_a": job["slot_a"],
            "slot_b": job["slot_b"],
        },
        "criterion": {
            "id": str(criterion["id"]),
            "name": str(criterion["name"]),
        },
        "criterion_index": job["criterion_index"],
        "repetition": job["repetition"],
        "cached": False,
        "requests": [],
    }
    _score_context.record = record
    started = time.perf_counter()
    try:
        slot_a_reward, slot_b_reward = module.score_pair_criterion(
            client,
            problem,
            candidates[job["slot_a"]],
            candidates[job["slot_b"]],
            criterion,
            ground_truth_note,
            VERIFIER_MODEL,
            None,
        )
        if job["swap"]:
            reward_a, reward_b = slot_b_reward, slot_a_reward
        else:
            reward_a, reward_b = slot_a_reward, slot_b_reward
        raw_delta = reward_a - reward_b
        record.update({
            "reward_a": reward_a,
            "reward_b": reward_b,
            "raw_delta": raw_delta,
            "bradley_terry_preference": (
                1.0 / (1.0 + math.exp(-raw_delta))
            ),
            "status": "success",
        })
    except Exception as error:
        record.update({
            "status": "failure",
            "failure_reason": getattr(error, "reason", "REQUEST_FAILED"),
        })
        if isinstance(error, VerifierCapabilityError):
            error.details["comparison"] = record
        raise
    finally:
        record["latency_ms"] = round(
            (time.perf_counter() - started) * 1000,
            3,
        )
        record["usage"] = _summed_request_usage(record["requests"])
        record["finish_reasons"] = [
            request.get("finish_reason")
            for request in record["requests"]
            if "finish_reason" in request
        ]
        del _score_context.record
    return str(job["key"]), {
        "score_A": record["reward_a"],
        "score_B": record["reward_b"],
        "diagnostic": record,
    }


def _score_comparison_jobs(
    module: Any,
    problem: str,
    candidates: list[str],
    ground_truth_note: str,
    jobs: list[dict[str, Any]],
    max_workers: int,
    cache_path: str | None,
    cache_entries: dict[str, Any],
    require_cached: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    pending = [job for job in jobs if job["key"] not in cache_entries]
    if require_cached and pending:
        raise RuntimeError(
            "verifier baseline comparison missing from selection cache: "
            f"{pending[0]['comparison_id']}"
        )
    cached_records = []
    for job in jobs:
        cached = cache_entries.get(job["key"])
        if cached is None:
            continue
        diagnostic = dict(cached["diagnostic"])
        diagnostic["cached"] = True
        cached_records.append(diagnostic)

    seen_prefixes = set()
    warm, rest = [], []
    for job in pending:
        prefix = (job["slot_a"], job["slot_b"])
        if prefix in seen_prefixes:
            rest.append(job)
        else:
            seen_prefixes.add(prefix)
            warm.append(job)

    client = _client() if pending else None
    fresh_records: list[dict[str, Any]] = []

    def run_wave(wave: list[dict[str, Any]]) -> None:
        if not wave:
            return
        with ThreadPoolExecutor(max_workers=min(max_workers, len(wave))) as executor:
            futures = {
                executor.submit(
                    _score_comparison_job,
                    module,
                    client,
                    problem,
                    candidates,
                    ground_truth_note,
                    job,
                ): job
                for job in wave
            }
            for future in as_completed(futures):
                key, entry = future.result()
                cache_entries[key] = entry
                fresh_records.append(entry["diagnostic"])
        _save_selection_cache(cache_path, cache_entries)

    run_wave(warm)
    run_wave(rest)
    records = cached_records + fresh_records
    records.sort(key=lambda item: (
        item["pair_index"],
        item["criterion_index"],
        item["repetition"],
    ))
    return cache_entries, records


def _aggregate_comparisons(
    module: Any,
    phase: str,
    pairs: list[tuple[int, int]],
    criteria: list[Mapping[str, Any]],
    n_evaluations: int,
    entries: Mapping[str, Any],
    wins: list[float],
    counts: list[int],
) -> list[dict[str, Any]]:
    summaries = []
    for pair_index, (candidate_a, candidate_b) in enumerate(pairs):
        rewards = []
        job_ids = []
        for criterion_index, criterion in enumerate(criteria):
            criterion_id = str(criterion["id"])
            for repetition in range(n_evaluations):
                key = _comparison_key(
                    phase,
                    pair_index,
                    candidate_a,
                    candidate_b,
                    criterion_id,
                    repetition,
                )
                entry = entries.get(key)
                if entry is None:
                    raise RuntimeError(
                        "verifier comparison result missing during aggregation: "
                        f"{phase}-{pair_index}-c{criterion_index}-r{repetition}"
                    )
                rewards.append((entry["score_A"], entry["score_B"]))
                job_ids.append(
                    f"{phase}-{pair_index}-c{criterion_index}-r{repetition}"
                )
        reward_a = sum(item[0] for item in rewards) / len(rewards)
        reward_b = sum(item[1] for item in rewards) / len(rewards)
        preference = module.ppt.bradley_terry(reward_a, reward_b)
        wins[candidate_a] += preference
        counts[candidate_a] += 1
        wins[candidate_b] += 1.0 - preference
        counts[candidate_b] += 1
        summaries.append({
            "comparison_id": f"{phase}-{pair_index}",
            "phase": phase,
            "candidate_a": candidate_a,
            "candidate_b": candidate_b,
            "job_ids": job_ids,
            "reward_a": reward_a,
            "reward_b": reward_b,
            "raw_delta": reward_a - reward_b,
            "bradley_terry_preference": preference,
        })
    return summaries


def _resolved_criteria(
    module: Any,
    configured: Mapping[str, str],
) -> tuple[str, list[Mapping[str, Any]]]:
    ground_truth_note, criteria = module._resolve_criteria(configured, None)
    return str(ground_truth_note), list(criteria)


def _select_candidates(
    module: Any,
    request: Mapping[str, Any],
    cache_path: str | None,
) -> dict[str, Any]:
    candidates = list(request["candidates"])
    ground_truth_note, criteria = _resolved_criteria(module, request["criteria"])
    criteria_ids = [str(criterion["id"]) for criterion in criteria]
    candidate_count = len(candidates)
    if candidate_count == 0:
        raise ValueError("need at least one candidate")
    if candidate_count == 1:
        return {
            "selected_index": 0,
            "scores": [1.0],
            "ranking": [0],
            "details": {
                "n_comparisons": 0,
                "criteria": criteria_ids,
                "comparisons": [],
                "scheduled_comparisons": [],
            },
        }

    escalating = request["operation"] == "select_escalation"
    n_evaluations = int(
        request.get("baseline_n_evaluations", request["n_evaluations"])
    )
    max_workers = int(request.get("max_workers") or module.default_max_workers())
    cache_entries = _load_selection_cache(cache_path)
    ring = list(module.ppt.ring_cycle(candidate_count, random.Random(0)))
    ring_jobs = _comparison_jobs("ring", ring, criteria, n_evaluations)
    cache_entries, ring_records = _score_comparison_jobs(
        module,
        str(request["problem"]),
        candidates,
        ground_truth_note,
        ring_jobs,
        max_workers,
        cache_path,
        cache_entries,
        require_cached=escalating,
    )

    ring_wins = [0.0] * candidate_count
    ring_counts = [0] * candidate_count
    ring_summaries = _aggregate_comparisons(
        module,
        "ring",
        ring,
        criteria,
        n_evaluations,
        cache_entries,
        ring_wins,
        ring_counts,
    )
    pivots = module.ppt.select_pivots(
        ring_wins,
        ring_counts,
        int(request["pivots"]),
    )
    pivot_pairs = list(module.ppt.pivot_round_pairs(candidate_count, pivots))
    pivot_jobs = _comparison_jobs(
        "pivot",
        pivot_pairs,
        criteria,
        n_evaluations,
    )
    cache_entries, pivot_records = _score_comparison_jobs(
        module,
        str(request["problem"]),
        candidates,
        ground_truth_note,
        pivot_jobs,
        max_workers,
        cache_path,
        cache_entries,
        require_cached=escalating,
    )

    wins = [0.0] * candidate_count
    counts = [0] * candidate_count
    scheduled = _aggregate_comparisons(
        module,
        "ring",
        ring,
        criteria,
        n_evaluations,
        cache_entries,
        wins,
        counts,
    )
    scheduled += _aggregate_comparisons(
        module,
        "pivot",
        pivot_pairs,
        criteria,
        n_evaluations,
        cache_entries,
        wins,
        counts,
    )
    adaptive_pairs: list[tuple[int, int]] = []
    adaptive_records: list[dict[str, Any]] = []
    adaptive_summaries: list[dict[str, Any]] = []
    if escalating:
        raw_pairs = request.get("adaptive_pairs")
        if not isinstance(raw_pairs, list) or not raw_pairs:
            raise ValueError("select_escalation requires non-empty adaptive_pairs")
        for raw_pair in raw_pairs:
            if (
                not isinstance(raw_pair, list)
                or len(raw_pair) != 2
                or any(
                    not isinstance(index, int)
                    or isinstance(index, bool)
                    or index < 0
                    or index >= candidate_count
                    for index in raw_pair
                )
                or raw_pair[0] == raw_pair[1]
            ):
                raise ValueError("adaptive_pairs must contain distinct candidate indices")
            adaptive_pairs.append((raw_pair[0], raw_pair[1]))
        adaptive_jobs = _comparison_jobs("adaptive", adaptive_pairs, criteria, 1)
        cache_entries, adaptive_records = _score_comparison_jobs(
            module,
            str(request["problem"]),
            candidates,
            ground_truth_note,
            adaptive_jobs,
            max_workers,
            cache_path,
            cache_entries,
        )
        adaptive_summaries = _aggregate_comparisons(
            module,
            "adaptive",
            adaptive_pairs,
            criteria,
            1,
            cache_entries,
            wins,
            counts,
        )
        scheduled += adaptive_summaries
    scores = [
        wins[index] / counts[index] if counts[index] else 0.0
        for index in range(candidate_count)
    ]
    ranking = sorted(range(candidate_count), key=lambda index: (-scores[index], index))
    return {
        "selected_index": ranking[0],
        "scores": scores,
        "ranking": ranking,
        "details": {
            "n_comparisons": (
                len(adaptive_pairs)
                if escalating
                else len(ring) + len(pivot_pairs)
            ),
            "criteria": criteria_ids,
            "comparisons": (
                adaptive_records
                if escalating
                else ring_records + pivot_records
            ),
            "scheduled_comparisons": scheduled,
            "ring_comparisons": ring_summaries,
            "adaptive_comparisons": adaptive_summaries,
        },
    }


def _compare_candidates(
    module: Any,
    request: Mapping[str, Any],
) -> dict[str, Any]:
    ground_truth_note, criteria = _resolved_criteria(module, request["criteria"])
    jobs = _comparison_jobs(
        "direct",
        [(0, 1)],
        criteria,
        int(request["n_evaluations"]),
    )
    entries, records = _score_comparison_jobs(
        module,
        str(request["problem"]),
        [str(request["candidate_a"]), str(request["candidate_b"])],
        ground_truth_note,
        jobs,
        int(request.get("max_workers") or module.default_max_workers()),
        None,
        {},
    )
    wins = [0.0, 0.0]
    counts = [0, 0]
    summaries = _aggregate_comparisons(
        module,
        "direct",
        [(0, 1)],
        criteria,
        int(request["n_evaluations"]),
        entries,
        wins,
        counts,
    )
    summary = summaries[0]
    return {
        "scores": [summary["reward_a"], summary["reward_b"]],
        "details": {
            "comparisons": records,
            "scheduled_comparisons": summaries,
        },
    }


def _execute_operation(request: Mapping[str, Any]) -> dict[str, Any]:
    module = _module()
    operation = request["operation"]
    planned = _planned_work(module, request)
    _enforce_operation_budget(request, planned)
    probe_details = None
    probe_telemetry = None
    if operation not in ("reset", "release_cache"):
        probe_before = _usage_snapshot(module)
        probe_started = time.perf_counter()
        probe_details = _ensure_capability(module)
        probe_usage = _usage_delta(probe_before, _usage_snapshot(module))
        cache_hit = probe_details.get("cache_hit") is True
        probe_telemetry = {
            "executed": not cache_hit,
            "cached": cache_hit,
            "latency_ms": round(
                (time.perf_counter() - probe_started) * 1000,
                3,
            ),
            "usage": probe_usage,
        }

    if operation == "capability":
        return {"capability": probe_details}

    operation_before = _usage_snapshot(module)
    operation_started = time.perf_counter()
    with _distribution_lock:
        _distribution_summaries.clear()

    if operation == "score":
        steps = request["steps"]
        result = module.track(
            request["problem"],
            steps,
            checkpoint_steps=[len(steps)],
            **_common(request),
        )
        value: dict[str, Any] = {
            "score": result.final,
            "details": {"checkpoint_steps": result.steps},
        }
    elif operation == "compare":
        value = _compare_candidates(module, request)
    elif operation in ("select", "select_escalation"):
        cache_id = request.get("cache_id")
        if operation == "select_escalation" and cache_id is None:
            raise ValueError("select_escalation requires cache_id")
        value = _select_candidates(
            module,
            request,
            None if cache_id is None else _selection_cache_path(cache_id),
        )
    elif operation == "progress":
        tracker_id = request["tracker_id"]
        signature = (
            request["problem"],
            request["model"],
            request["n_evaluations"],
            request.get("max_workers"),
        )
        now = time.monotonic()
        _prune_trackers(now, tracker_id)
        entry = _trackers.get(tracker_id)
        if entry is None or entry[0] != signature:
            tracker = module.ProgressTracker(
                request["problem"],
                **_common(request),
            )
            _trackers[tracker_id] = (signature, tracker, now)
        else:
            tracker = entry[1]
        score = tracker.update(request["step"])
        _trackers[tracker_id] = (signature, tracker, now)
        value = {"score": score, "step_index": len(tracker.steps)}
    elif operation == "reset":
        _trackers.pop(request["tracker_id"], None)
        value = {}
    elif operation == "release_cache":
        try:
            os.remove(_selection_cache_path(request["cache_id"]))
        except FileNotFoundError:
            pass
        value = {}
    else:
        raise ValueError(f"unsupported operation: {operation!r}")

    operation_usage = _usage_delta(operation_before, _usage_snapshot(module))
    operation_latency_ms = (time.perf_counter() - operation_started) * 1000
    value["usage"] = operation_usage
    with _distribution_lock:
        distributions = list(_distribution_summaries)
    details = value.setdefault("details", {})
    if distributions:
        details["score_distributions"] = distributions
    if probe_details is not None:
        details["capability_probe"] = probe_details
    details["telemetry"] = _operation_telemetry(
        request,
        value,
        planned,
        operation_usage,
        operation_latency_ms,
        probe_telemetry,
    )
    return value


def _execute(request: Mapping[str, Any]) -> dict[str, Any]:
    operation = request["operation"]
    if operation in ("reset", "release_cache"):
        return _execute_operation(request)
    effort = request.get("reasoning_effort", "high")
    if effort not in ("off", "low", "high"):
        raise ValueError("reasoning_effort must be off, low, or high")
    client = _client()
    with client.request_policy(str(effort)):
        return _execute_operation(request)


def _safe_message(error: BaseException) -> str:
    message = str(error)
    for name, value in os.environ.items():
        if value and any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
            message = message.replace(value, "<redacted>")
    return message[:1000]


def _respond(request_id: Any, payload: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps({"id": request_id, **payload}, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    """Serve requests until stdin closes."""
    for line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise TypeError("request must be a JSON object")
            request_id = request.get("id")
            _respond(request_id, {"ok": True, "result": _execute(request)})
        except BaseException as error:  # The process must return a structured backend failure.
            error_payload: dict[str, Any] = {
                "code": type(error).__name__,
                "message": _safe_message(error),
            }
            error_details = getattr(error, "details", None)
            if isinstance(error_details, Mapping):
                error_payload["details"] = dict(error_details)
            _respond(
                request_id,
                {
                    "ok": False,
                    "error": error_payload,
                },
            )


if __name__ == "__main__":
    main()
