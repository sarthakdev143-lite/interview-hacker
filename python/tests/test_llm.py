# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import sys
import unittest
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import llm  # noqa: E402
from llm import (  # noqa: E402
    ANSWER_MODEL_PREFERENCES,
    DEFAULT_ANSWER_MODEL,
    LLM_MAX_ATTEMPTS,
    MAX_RETRY_WAIT_SECONDS,
    LLMClient,
    is_chat_model,
    is_rate_limit,
    is_reasoning_model,
    is_retryable,
    list_chat_models,
    list_chat_models_or_empty,
    pick_model,
    retry_after_seconds,
)


class FakeModel:
    def __init__(self, model_id: str, active: bool = True):
        self.id = model_id
        self.active = active


class FakeModels:
    def __init__(self, ids, raises=False):
        self.data = [FakeModel(i) for i in ids]
        self.raises = raises

    def list(self):
        if self.raises:
            raise RuntimeError("network down")
        return self


class FakeClient:
    def __init__(self, ids, raises=False):
        self.models = FakeModels(ids, raises)


# What the account in this repo actually exposes today.
LIVE_MODELS = [
    "allam-2-7b",
    "groq/compound",
    "groq/compound-mini",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
    "qwen/qwen3.8-27b",
]


class ModelFilteringTests(unittest.TestCase):
    def test_non_chat_models_are_excluded(self):
        for model_id in (
            "whisper-large-v3-turbo",
            "canopylabs/orpheus-v1-english",
            "meta-llama/llama-prompt-guard-2-22m",
        ):
            self.assertFalse(is_chat_model(model_id), model_id)

    def test_chat_models_are_kept(self):
        for model_id in ("openai/gpt-oss-120b", "qwen/qwen3.8-27b", "groq/compound"):
            self.assertTrue(is_chat_model(model_id), model_id)

    def test_listing_filters_and_sorts(self):
        client = FakeClient(LIVE_MODELS + ["whisper-large-v3", "canopylabs/orpheus-v1-english"])

        models = list_chat_models(client)

        self.assertEqual(models, sorted(LIVE_MODELS))

    def test_listing_propagates_an_api_failure(self):
        """The picker needs to tell an invalid key apart from an empty account.

        Swallowing the error and returning [] made a rejected key, a network
        outage and a genuinely empty catalog indistinguishable, so the dashboard
        showed an empty model list with no explanation for any of them.
        """
        with self.assertRaises(RuntimeError):
            list_chat_models(FakeClient([], raises=True))

    def test_session_start_still_survives_an_api_failure(self):
        """Absence of evidence is not evidence the model is gone."""
        self.assertEqual(list_chat_models_or_empty(FakeClient([], raises=True)), [])

    def test_resolve_models_keeps_the_request_when_the_catalog_is_unreachable(self):
        client = LLMClient.__new__(LLMClient)
        client.client = FakeClient([], raises=True)
        client.default_model = DEFAULT_ANSWER_MODEL
        client.classifier_model = ""
        client.available_models = []

        resolution = client.resolve_models("openai/gpt-oss-120b")

        self.assertEqual(resolution["answer_model"], "openai/gpt-oss-120b")
        self.assertEqual(resolution["fell_back_from"], "")


class PickModelTests(unittest.TestCase):
    def test_first_available_preference_wins(self):
        self.assertEqual(
            pick_model(ANSWER_MODEL_PREFERENCES, sorted(LIVE_MODELS), DEFAULT_ANSWER_MODEL),
            "openai/gpt-oss-120b",
        )

    def test_falls_through_to_the_next_preference(self):
        available = ["openai/gpt-oss-20b", "allam-2-7b"]

        self.assertEqual(
            pick_model(ANSWER_MODEL_PREFERENCES, available, DEFAULT_ANSWER_MODEL),
            "openai/gpt-oss-20b",
        )

    def test_unrecognised_catalog_still_yields_something_usable(self):
        self.assertEqual(
            pick_model(ANSWER_MODEL_PREFERENCES, ["some-new-model"], DEFAULT_ANSWER_MODEL),
            "some-new-model",
        )

    def test_empty_catalog_uses_the_fallback(self):
        self.assertEqual(
            pick_model(ANSWER_MODEL_PREFERENCES, [], DEFAULT_ANSWER_MODEL),
            DEFAULT_ANSWER_MODEL,
        )


class ReasoningModelTests(unittest.TestCase):
    def test_gpt_oss_and_qwen3_are_reasoning_models(self):
        self.assertTrue(is_reasoning_model("openai/gpt-oss-120b"))
        self.assertTrue(is_reasoning_model("qwen/qwen3.8-27b"))

    def test_llama_is_not(self):
        self.assertFalse(is_reasoning_model("llama-3.3-70b-versatile"))


class ResolveModelsTests(unittest.TestCase):
    def _client(self, ids, raises=False):
        client = LLMClient(api_key="test-key")
        client.client = FakeClient(ids, raises)
        return client

    def test_retired_model_falls_back_and_is_reported(self):
        """The exact breakage this repo hit: a saved model Groq removed."""
        client = self._client(LIVE_MODELS)

        result = client.resolve_models("llama-3.3-70b-versatile")

        self.assertEqual(result["answer_model"], "openai/gpt-oss-120b")
        self.assertEqual(result["fell_back_from"], "llama-3.3-70b-versatile")
        self.assertEqual(client.default_model, "openai/gpt-oss-120b")

    def test_available_model_is_left_alone(self):
        client = self._client(LIVE_MODELS)

        result = client.resolve_models("openai/gpt-oss-20b")

        self.assertEqual(result["answer_model"], "openai/gpt-oss-20b")
        self.assertEqual(result["fell_back_from"], "")

    def test_classifier_is_resolved_to_a_cheap_available_model(self):
        client = self._client(LIVE_MODELS)

        result = client.resolve_models("openai/gpt-oss-120b")

        self.assertEqual(result["classifier_model"], "openai/gpt-oss-20b")
        self.assertIn(result["classifier_model"], LIVE_MODELS)

    def test_unreachable_catalog_keeps_the_requested_model(self):
        client = self._client([], raises=True)

        result = client.resolve_models("llama-3.3-70b-versatile")

        # Without a catalog there is no evidence the model is gone, and
        # refusing to start would be worse than trying.
        self.assertEqual(result["answer_model"], "llama-3.3-70b-versatile")
        self.assertEqual(result["fell_back_from"], "")

    def test_no_requested_model_picks_the_recommended_one(self):
        client = self._client(LIVE_MODELS)

        result = client.resolve_models("")

        self.assertEqual(result["answer_model"], "openai/gpt-oss-120b")


class CreateOptionsTests(unittest.TestCase):
    class RecordingCompletions:
        def __init__(self, fail_on_reasoning=False):
            self.calls: list[dict] = []
            self.fail_on_reasoning = fail_on_reasoning

        def create(self, **kwargs):
            self.calls.append(kwargs)
            if self.fail_on_reasoning and "reasoning_effort" in kwargs:
                raise RuntimeError(
                    "Error code: 400 - `reasoning_effort` must be one of `low`, `medium`"
                )
            return "response"

    def _client(self, completions):
        client = LLMClient(api_key="test-key")
        chat = type("Chat", (), {})()
        chat.completions = completions
        client.client = type("Client", (), {"chat": chat})()
        return client

    def test_reasoning_models_get_a_low_effort_budget(self):
        completions = self.RecordingCompletions()
        client = self._client(completions)

        client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertEqual(completions.calls[0]["reasoning_effort"], "low")
        self.assertEqual(completions.calls[0]["max_completion_tokens"], 900)

    def test_non_reasoning_models_do_not_get_the_parameter(self):
        completions = self.RecordingCompletions()
        client = self._client(completions)

        client._create(
            model="llama-3.3-70b-versatile",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertNotIn("reasoning_effort", completions.calls[0])

    def test_a_model_that_rejects_the_parameter_is_retried_without_it(self):
        completions = self.RecordingCompletions(fail_on_reasoning=True)
        client = self._client(completions)

        result = client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertEqual(result, "response")
        self.assertEqual(len(completions.calls), 2)
        self.assertNotIn("reasoning_effort", completions.calls[1])


class ApiError(Exception):
    """Stands in for a groq SDK APIStatusError."""

    def __init__(self, status_code, retry_after=None):
        super().__init__(f"Error code: {status_code}")
        self.status_code = status_code
        if retry_after is not None:
            self.response = type(
                "Response", (), {"headers": {"retry-after": retry_after}}
            )()


class ErrorClassificationTests(unittest.TestCase):
    def test_rate_limits_are_recognised(self):
        self.assertTrue(is_rate_limit(ApiError(429)))
        self.assertFalse(is_rate_limit(ApiError(400)))

    def test_transient_statuses_are_retryable(self):
        for status in (408, 429, 500, 502, 503, 504):
            self.assertTrue(is_retryable(ApiError(status)), status)

    def test_client_errors_are_not_retryable(self):
        for status in (400, 401, 403, 404):
            self.assertFalse(is_retryable(ApiError(status)), status)

    def test_connection_failures_are_retryable(self):
        class APIConnectionError(Exception):
            pass

        self.assertTrue(is_retryable(APIConnectionError("boom")))

    def test_retry_after_header_is_honoured(self):
        self.assertEqual(retry_after_seconds(ApiError(429, retry_after="7")), 7.0)
        self.assertEqual(retry_after_seconds(ApiError(429, retry_after="2.5s")), 2.5)

    def test_missing_or_junk_retry_after_is_ignored(self):
        self.assertIsNone(retry_after_seconds(ApiError(429)))
        self.assertIsNone(retry_after_seconds(ApiError(429, retry_after="soon")))


class RetryBehaviourTests(unittest.TestCase):
    class FlakyCompletions:
        def __init__(self, failures, status=429, retry_after=None):
            self.remaining = failures
            self.status = status
            self.retry_after = retry_after
            self.calls = []

        def create(self, **kwargs):
            self.calls.append(kwargs)
            if self.remaining > 0:
                self.remaining -= 1
                raise ApiError(self.status, self.retry_after)
            return "ok"

    def _client(self, completions, available=None):
        client = LLMClient(api_key="test-key")
        chat = type("Chat", (), {})()
        chat.completions = completions
        client.client = type("Client", (), {"chat": chat})()
        client.available_models = available or []
        return client

    def setUp(self):
        self.slept = []
        self._real_sleep = llm.time.sleep
        llm.time.sleep = self.slept.append

    def tearDown(self):
        llm.time.sleep = self._real_sleep

    def test_a_transient_rate_limit_is_ridden_out(self):
        completions = self.FlakyCompletions(failures=1)
        client = self._client(completions)

        result = client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertEqual(result, "ok")
        self.assertEqual(len(completions.calls), 2)
        self.assertEqual(len(self.slept), 1)

    def test_the_servers_retry_after_beats_the_default_backoff(self):
        completions = self.FlakyCompletions(failures=1, retry_after="4")
        client = self._client(completions)

        client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertEqual(self.slept, [4.0])

    def test_an_absurd_retry_after_is_capped(self):
        completions = self.FlakyCompletions(failures=1, retry_after="600")
        client = self._client(completions)

        client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertEqual(self.slept, [MAX_RETRY_WAIT_SECONDS])

    def test_a_bad_request_is_not_retried(self):
        completions = self.FlakyCompletions(failures=5, status=400)
        client = self._client(completions)

        with self.assertRaises(ApiError):
            client._create(
                model="openai/gpt-oss-120b",
                messages=[],
                max_tokens=900,
                stream=False,
                temperature=0.35,
            )

        self.assertEqual(len(completions.calls), 1)
        self.assertEqual(self.slept, [])

    def test_a_persistent_rate_limit_switches_model(self):
        """Groq meters per model, so a sibling is faster than a longer wait."""
        completions = self.FlakyCompletions(failures=LLM_MAX_ATTEMPTS)
        client = self._client(
            completions, available=["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
        )

        result = client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
            allow_model_fallback=True,
        )

        self.assertEqual(result, "ok")
        self.assertEqual(completions.calls[-1]["model"], "openai/gpt-oss-20b")

    def test_without_fallback_it_gives_up_after_the_attempt_budget(self):
        completions = self.FlakyCompletions(failures=99)
        client = self._client(completions)

        with self.assertRaises(ApiError):
            client._create(
                model="openai/gpt-oss-120b",
                messages=[],
                max_tokens=900,
                stream=False,
                temperature=0.35,
            )

        self.assertEqual(len(completions.calls), LLM_MAX_ATTEMPTS)

    def test_the_user_is_told_a_retry_is_happening(self):
        notices = []
        completions = self.FlakyCompletions(failures=1, retry_after="3")
        client = self._client(completions)
        client.on_retry = lambda reason, wait: notices.append((reason, wait))

        client._create(
            model="openai/gpt-oss-120b",
            messages=[],
            max_tokens=900,
            stream=False,
            temperature=0.35,
        )

        self.assertEqual(len(notices), 1)
        self.assertIn("rate limited", notices[0][0])
        self.assertEqual(notices[0][1], 3.0)



if __name__ == "__main__":
    unittest.main()
