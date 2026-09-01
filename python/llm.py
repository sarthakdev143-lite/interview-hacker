# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

from __future__ import annotations

import time
from typing import Callable

from groq import Groq

from wingman_logging import get_logger, redact

log = get_logger("llm")

SYSTEM_PROMPT = """
You are WingMan, a real-time interview assistant. Your job is to help the candidate answer interview questions clearly, confidently, and concisely.

Rules:
- Give direct, structured answers.
- Keep answers under 150 words unless the question is notably complex.
- Tailor answers to the candidate's resume and extra context.
- Match the interview language when practical, while preserving technical terms and code in their original spelling.
- For coding questions, provide clean, commented code with a short explanation.
- Never mention that you are an AI assistant.

Interview Language:
{language}

Candidate Resume:
{resume_text}

Extra Context:
{extra_context}
"""

QUESTION_CHECK_PROMPT = """
You classify transcript snippets from an interview.
The text may be in any language, and may be a raw transcript of spoken audio.
Answer with only YES or NO.
Return YES only if the text is clearly an interview question or interview prompt directed at the candidate.
An imperative request such as "tell me about a time you..." is an interview prompt, whatever the language.
"""

DEFAULT_ANSWER_MODEL = "openai/gpt-oss-120b"
DEFAULT_CLASSIFIER_MODEL = "openai/gpt-oss-20b"

# Groq retires model IDs regularly, so nothing here is assumed to exist. These
# are preference orders, filtered against what the key can actually reach.
ANSWER_MODEL_PREFERENCES = (
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "llama-3.3-70b-versatile",
    "groq/compound",
    "groq/compound-mini",
)

CLASSIFIER_MODEL_PREFERENCES = (
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
)

# Models that spend part of their completion budget on hidden reasoning. They
# return empty content unless the budget comfortably exceeds that reasoning,
# and they accept `reasoning_effort` to keep it short.
REASONING_MODEL_PREFIXES = ("openai/gpt-oss", "qwen/qwen3")

# Substrings that mark a model as not usable for chat completions.
NON_CHAT_MARKERS = ("whisper", "orpheus", "prompt-guard", "guard", "tts", "embed")

# Generous enough that hidden reasoning cannot swallow the whole answer.
ANSWER_MAX_TOKENS = 900
CLASSIFIER_MAX_TOKENS = 96

# Rate limiting is the expected failure mode on a free tier, not an exception,
# so it is retried rather than surfaced as a dead session.
LLM_MAX_ATTEMPTS = 3
LLM_RETRY_BACKOFF_SECONDS = (1.0, 3.0)
# Nobody waits half a minute mid-interview; past this, move on and say so.
MAX_RETRY_WAIT_SECONDS = 10.0
RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})

# (model, prompt_tokens, completion_tokens)
UsageCallback = Callable[[str, int, int], None]
# (human-readable reason, seconds about to be waited)
RetryCallback = Callable[[str, float], None]


def status_of(error: Exception) -> int | None:
    status = getattr(error, "status_code", None)
    return status if isinstance(status, int) else None


def is_rate_limit(error: Exception) -> bool:
    return status_of(error) == 429


def is_retryable(error: Exception) -> bool:
    status = status_of(error)
    if status is not None:
        return status in RETRYABLE_STATUS

    name = type(error).__name__.lower()
    return any(marker in name for marker in ("connection", "timeout"))


def retry_after_seconds(error: Exception) -> float | None:
    """Groq reports how long to wait; honouring it beats guessing a backoff."""
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None

    try:
        raw = headers.get("retry-after")
    except Exception:  # pragma: no cover - defensive
        return None

    if not raw:
        return None

    try:
        # Groq sends plain seconds; some gateways append a unit suffix.
        return max(0.0, float(str(raw).strip().rstrip("s")))
    except ValueError:
        return None


def is_reasoning_model(model: str) -> bool:
    return model.startswith(REASONING_MODEL_PREFIXES)


def is_chat_model(model_id: str) -> bool:
    lowered = model_id.lower()
    return not any(marker in lowered for marker in NON_CHAT_MARKERS)


def list_chat_models(client: Groq) -> list[str]:
    """Chat-capable model IDs this API key can actually reach."""
    try:
        response = client.models.list()
    except Exception as error:
        print(f"[wingman] Could not list Groq models: {error}")
        return []

    models = []
    for entry in getattr(response, "data", []) or []:
        model_id = str(getattr(entry, "id", "") or "")
        if not model_id or not is_chat_model(model_id):
            continue
        if getattr(entry, "active", True) is False:
            continue
        models.append(model_id)

    return sorted(models)


def pick_model(preferences: tuple[str, ...], available: list[str], fallback: str) -> str:
    for candidate in preferences:
        if candidate in available:
            return candidate
    return available[0] if available else fallback


def _report(on_usage: UsageCallback | None, model: str, usage: object | None) -> None:
    if on_usage is None or usage is None:
        return

    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    if prompt_tokens or completion_tokens:
        on_usage(model, prompt_tokens, completion_tokens)


def _rejects_reasoning_effort(error: Exception) -> bool:
    return "reasoning_effort" in str(error)


class LLMClient:
    def __init__(
        self,
        api_key: str,
        on_usage: UsageCallback | None = None,
        answer_model: str | None = None,
        classifier_model: str | None = None,
        on_retry: RetryCallback | None = None,
    ):
        self.client = Groq(api_key=api_key)
        self.default_model = answer_model or DEFAULT_ANSWER_MODEL
        self.classifier_model = classifier_model or DEFAULT_CLASSIFIER_MODEL
        self.on_usage = on_usage
        self.on_retry = on_retry
        self.available_models: list[str] = []

    # ------------------------------------------------------------------
    # Model resolution
    # ------------------------------------------------------------------

    def resolve_models(self, requested_answer_model: str = "") -> dict:
        """Reconciles the requested model with what the key can reach.

        Model IDs are retired regularly, and a stored preference outlives them,
        so a session must never fail just because a saved model disappeared.
        """
        available = list_chat_models(self.client)
        self.available_models = available

        requested = (requested_answer_model or "").strip()
        if available and requested and requested not in available:
            replacement = pick_model(ANSWER_MODEL_PREFERENCES, available, DEFAULT_ANSWER_MODEL)
            print(
                f"[wingman] Model {requested!r} is unavailable on this key; "
                f"falling back to {replacement!r}"
            )
            self.default_model = replacement
            fell_back_from = requested
        else:
            self.default_model = requested or pick_model(
                ANSWER_MODEL_PREFERENCES, available, DEFAULT_ANSWER_MODEL
            )
            fell_back_from = ""

        self.classifier_model = pick_model(
            CLASSIFIER_MODEL_PREFERENCES, available, DEFAULT_CLASSIFIER_MODEL
        )

        return {
            "answer_model": self.default_model,
            "classifier_model": self.classifier_model,
            "available_models": available,
            "fell_back_from": fell_back_from,
        }

    # ------------------------------------------------------------------
    # Completions
    # ------------------------------------------------------------------

    def _request(self, model: str, messages: list, max_tokens: int, stream: bool, temperature: float):
        options = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
            "stream": stream,
        }
        if is_reasoning_model(model):
            options["reasoning_effort"] = "low"

        try:
            return self.client.chat.completions.create(**options)
        except Exception as error:
            # Some models reject the parameter outright; retry plainly.
            if "reasoning_effort" in options and _rejects_reasoning_effort(error):
                options.pop("reasoning_effort")
                return self.client.chat.completions.create(**options)
            raise

    def _sibling_model(self, primary: str) -> str | None:
        """A different live model to try when `primary` is rate limited.

        Groq meters per model, so the quickest way past a 429 is usually a
        different model rather than a longer wait.
        """
        for candidate in ANSWER_MODEL_PREFERENCES:
            if candidate != primary and candidate in self.available_models:
                return candidate
        return None

    def _notify_retry(self, message: str, wait_seconds: float) -> None:
        if self.on_retry is None:
            return
        try:
            self.on_retry(message, wait_seconds)
        except Exception:  # pragma: no cover - defensive
            pass

    def _create(
        self,
        *,
        model: str,
        messages: list,
        max_tokens: int,
        stream: bool,
        temperature: float,
        allow_model_fallback: bool = False,
    ):
        """Creates a completion, riding out transient failures.

        Only the create call is retried. Once a stream starts yielding it is
        never restarted, because the caller has already shown those tokens.
        """
        models = [model]
        if allow_model_fallback:
            sibling = self._sibling_model(model)
            if sibling:
                models.append(sibling)

        last_error: Exception | None = None

        for index, candidate in enumerate(models):
            for attempt in range(LLM_MAX_ATTEMPTS):
                try:
                    return self._request(candidate, messages, max_tokens, stream, temperature)
                except Exception as error:
                    last_error = error
                    if not is_retryable(error):
                        raise

                    if attempt == LLM_MAX_ATTEMPTS - 1:
                        break

                    wait = retry_after_seconds(error)
                    if wait is None:
                        wait = LLM_RETRY_BACKOFF_SECONDS[
                            min(attempt, len(LLM_RETRY_BACKOFF_SECONDS) - 1)
                        ]
                    wait = min(wait, MAX_RETRY_WAIT_SECONDS)

                    reason = (
                        f"{candidate} is rate limited"
                        if is_rate_limit(error)
                        else f"{candidate} request failed ({type(error).__name__})"
                    )
                    log.warning("%s; retrying in %.1fs", reason, wait)
                    self._notify_retry(reason, wait)
                    time.sleep(wait)

            # Switching models only helps for a per-model quota.
            is_last_model = index == len(models) - 1
            if is_last_model or last_error is None or not is_rate_limit(last_error):
                break

            log.warning("Falling back from %s to %s", candidate, models[index + 1])
            self._notify_retry(
                f"{candidate} is still rate limited; trying {models[index + 1]}", 0.0
            )

        raise last_error if last_error else RuntimeError("Completion failed.")

    def is_question(self, transcript: str) -> bool:
        if not transcript.strip():
            return False

        response = self._create(
            model=self.classifier_model,
            messages=[
                {"role": "system", "content": QUESTION_CHECK_PROMPT},
                {"role": "user", "content": transcript},
            ],
            temperature=0,
            max_tokens=CLASSIFIER_MAX_TOKENS,
            stream=False,
        )
        _report(self.on_usage, self.classifier_model, getattr(response, "usage", None))
        content = response.choices[0].message.content or ""
        return content.strip().upper().startswith("YES")

    def stream_answer(self, question: str, session: dict):
        system = SYSTEM_PROMPT.format(
            language=session.get("language", "en"),
            resume_text=session.get("resume_text", "Not provided"),
            extra_context=session.get("extra_context", "None"),
        )
        model = session.get("model") or self.default_model
        stream = self._create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": question},
            ],
            temperature=0.35,
            max_tokens=ANSWER_MAX_TOKENS,
            stream=True,
            allow_model_fallback=True,
        )

        for chunk in stream:
            # Groq attaches real token counts to the final streamed chunk.
            x_groq = getattr(chunk, "x_groq", None)
            if x_groq is not None:
                _report(self.on_usage, model, getattr(x_groq, "usage", None))

            if not chunk.choices:
                continue

            # `delta.reasoning` is the model thinking aloud; only content is
            # ever shown to the candidate.
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
