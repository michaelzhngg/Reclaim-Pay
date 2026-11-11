"""Fallback order: configured Gemini model -> Gemini quota fallbacks on 429 -> OpenRouter."""
import asyncio

import httpx
import openai
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_openai import ChatOpenAI

from core.config import settings
from engine import llm

GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/"


def _status_error(cls, code):
    response = httpx.Response(code, request=httpx.Request("POST", GEMINI))
    return cls(f"HTTP {code}", response=response, body=None)


@pytest.fixture
def fake_api(monkeypatch):
    """Each model answers with its own name unless told to fail with an exception."""
    failures: dict[str, Exception] = {}
    calls: list[str] = []

    def answer(model):
        calls.append(model.model_name)
        if model.model_name in failures:
            raise failures[model.model_name]
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=model.model_name))])

    def fake_generate(self, messages, stop=None, run_manager=None, **kwargs):
        return answer(self)

    async def fake_agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return answer(self)

    monkeypatch.setattr(ChatOpenAI, "_generate", fake_generate)
    monkeypatch.setattr(ChatOpenAI, "_agenerate", fake_agenerate)

    flagged = []
    monkeypatch.setattr(llm, "set_glm_fallback", lambda: flagged.append(True))

    for name, value in {
        "LLM_BASE_URL": GEMINI,
        "LLM_API_KEY": "gemini-key",
        "CHAT_MODEL": "gemini-3.6-flash",
        "VISION_BASE_URL": GEMINI,
        "VISION_API_KEY": "gemini-key",
        "VISION_MODEL": "gemini-3.6-flash",
        "GEMINI_QUOTA_FALLBACK_MODELS": "gemini-3.5-flash-lite,gemini-3.1-flash-lite",
        "OPENROUTER_BASE_URL": "https://openrouter.example/v1",
        "OPENROUTER_API_KEY": "or-key",
    }.items():
        monkeypatch.setattr(settings, name, value)
    for getter in (llm.get_chat_llm, llm.get_vision_llm, llm.get_agent_llm, llm.get_text_llm):
        getter.cache_clear()
    yield failures, calls, flagged
    for getter in (llm.get_chat_llm, llm.get_vision_llm, llm.get_agent_llm, llm.get_text_llm):
        getter.cache_clear()


def _ask(model):
    return model.invoke([HumanMessage(content="hi")]).content


def test_primary_answers_when_healthy(fake_api):
    _, calls, flagged = fake_api
    assert _ask(llm.get_chat_llm()) == "gemini-3.6-flash"
    assert calls == ["gemini-3.6-flash"]
    assert not flagged


def test_429_moves_to_next_gemini_model(fake_api):
    failures, calls, flagged = fake_api
    failures["gemini-3.6-flash"] = _status_error(openai.RateLimitError, 429)
    assert _ask(llm.get_chat_llm()) == "gemini-3.5-flash-lite"
    assert calls == ["gemini-3.6-flash", "gemini-3.5-flash-lite"]
    assert not flagged


def test_every_gemini_429_ends_on_openrouter(fake_api):
    failures, calls, flagged = fake_api
    for name in ("gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"):
        failures[name] = _status_error(openai.RateLimitError, 429)
    assert _ask(llm.get_chat_llm()) == llm.FALLBACK_MODEL
    assert calls == ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", llm.FALLBACK_MODEL]
    assert flagged


def test_non_quota_error_goes_straight_to_openrouter(fake_api):
    failures, calls, _ = fake_api
    failures["gemini-3.6-flash"] = _status_error(openai.InternalServerError, 503)
    assert _ask(llm.get_chat_llm()) == llm.FALLBACK_MODEL
    assert calls == ["gemini-3.6-flash", llm.FALLBACK_MODEL]


def test_vision_uses_the_same_chain(fake_api):
    failures, calls, _ = fake_api
    failures["gemini-3.6-flash"] = _status_error(openai.RateLimitError, 429)
    failures["gemini-3.5-flash-lite"] = _status_error(openai.RateLimitError, 429)
    assert _ask(llm.get_vision_llm()) == "gemini-3.1-flash-lite"
    assert calls == ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]


def test_async_path_follows_the_chain(fake_api):
    failures, calls, _ = fake_api
    failures["gemini-3.6-flash"] = _status_error(openai.RateLimitError, 429)
    result = asyncio.run(llm.get_agent_llm().ainvoke([HumanMessage(content="hi")]))
    assert result.content == "gemini-3.5-flash-lite"


def test_primary_is_not_repeated_in_the_chain(fake_api, monkeypatch):
    failures, calls, _ = fake_api
    monkeypatch.setattr(settings, "VISION_MODEL", "gemini-3.5-flash-lite")
    llm.get_vision_llm.cache_clear()
    failures["gemini-3.5-flash-lite"] = _status_error(openai.RateLimitError, 429)
    assert _ask(llm.get_vision_llm()) == "gemini-3.1-flash-lite"
    assert calls == ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]


def test_no_gemini_fallbacks_off_gemini(fake_api, monkeypatch):
    failures, calls, _ = fake_api
    monkeypatch.setattr(settings, "LLM_BASE_URL", "https://api.ilmu.ai/v1")
    monkeypatch.setattr(settings, "CHAT_MODEL", "ilmu-glm-5.1")
    llm.get_chat_llm.cache_clear()
    failures["ilmu-glm-5.1"] = _status_error(openai.RateLimitError, 429)
    assert _ask(llm.get_chat_llm()) == llm.FALLBACK_MODEL
    assert calls == ["ilmu-glm-5.1", llm.FALLBACK_MODEL]


def test_vision_on_openrouter_has_no_extra_fallback(fake_api, monkeypatch):
    failures, calls, _ = fake_api
    monkeypatch.setattr(settings, "VISION_BASE_URL", "")
    monkeypatch.setattr(settings, "VISION_MODEL", "qwen/qwen3.5-flash-02-23")
    llm.get_vision_llm.cache_clear()
    failures["qwen/qwen3.5-flash-02-23"] = _status_error(openai.RateLimitError, 429)
    with pytest.raises(openai.RateLimitError):
        _ask(llm.get_vision_llm())
    assert calls == ["qwen/qwen3.5-flash-02-23"]
