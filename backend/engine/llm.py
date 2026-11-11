import logging
from functools import lru_cache
from typing import Any, Optional

import openai

from langchain_core.outputs import ChatResult
from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from pydantic import PrivateAttr

from core.config import settings
from core.notification_store import set_glm_fallback

logger = logging.getLogger(__name__)

FALLBACK_MODEL = "google/gemini-3.1-flash-lite-preview"
GEMINI_HOST = "generativelanguage.googleapis.com"

_JSON_MODE = {"response_format": {"type": "json_object"}}


def check_glm_health() -> None:
    return True
    # GLM 5.1 health check deactivated — fallback is now handled per-call.


def _is_empty(content: Any) -> bool:
    """True if GLM returned a useless empty body (502 pattern)."""
    return str(content).strip() in ("", "{}") if content is not None else True


def _gemini_quota_fallbacks(base_url: str, primary: str) -> list[str]:
    """Gemini models to try, in order, when the one before them answers 429 (quota/rate limit).
    Only on the Gemini API: these model names mean nothing to other providers."""
    if GEMINI_HOST not in (base_url or ""):
        return []
    models = [m.strip() for m in settings.GEMINI_QUOTA_FALLBACK_MODELS.split(",") if m.strip()]
    return [m for m in dict.fromkeys(models) if m != primary]


class _ChatWithFallbacks(ChatOpenAI):
    """Primary model, then each quota fallback on 429, then OpenRouter as the last resort.

    Any other failure (5xx, timeout, empty body) skips the remaining Gemini models and goes
    straight to OpenRouter, as before.
    """

    _quota_fallbacks: list[ChatOpenAI] = PrivateAttr(default_factory=list)
    _fallback_llm: Optional[ChatOpenAI] = PrivateAttr(default=None)

    def set_fallback(self, fallback: Optional[ChatOpenAI]) -> None:
        self._fallback_llm = fallback

    def set_quota_fallbacks(self, fallbacks: list[ChatOpenAI]) -> None:
        self._quota_fallbacks = fallbacks

    def _tiers(self, primary_call):
        return [(self.model_name, primary_call)] + [(m.model_name, m._generate) for m in self._quota_fallbacks]

    def _atiers(self, primary_call):
        return [(self.model_name, primary_call)] + [(m.model_name, m._agenerate) for m in self._quota_fallbacks]

    def _last_resort(self, exc: Exception, model: str) -> ChatOpenAI:
        if self._fallback_llm is None:
            raise exc
        logger.warning("%s failed (%s); switching to OpenRouter %s.", model, exc, self._fallback_llm.model_name)
        set_glm_fallback()
        return self._fallback_llm

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        error: Exception = RuntimeError("no model tried")
        for model, call in self._tiers(super()._generate):
            try:
                result = call(messages, stop=stop, run_manager=run_manager, **kwargs)
                if _is_empty(result.generations[0].message.content if result.generations else ""):
                    raise ValueError(f"empty response from {model}")
                return result
            except openai.RateLimitError as exc:
                logger.warning("%s returned 429 (%s); trying the next model.", model, exc)
                error = exc
            except Exception as exc:
                error = exc
                break
        return self._last_resort(error, model)._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        error: Exception = RuntimeError("no model tried")
        for model, call in self._atiers(super()._agenerate):
            try:
                result = await call(messages, stop=stop, run_manager=run_manager, **kwargs)
                if _is_empty(result.generations[0].message.content if result.generations else ""):
                    raise ValueError(f"empty response from {model}")
                return result
            except openai.RateLimitError as exc:
                logger.warning("%s returned 429 (%s); trying the next model.", model, exc)
                error = exc
            except Exception as exc:
                error = exc
                break
        fallback = self._last_resort(error, model)
        return await fallback._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)


# temperature=0 so the same receipt gets the same verdict in every demo take.
def _make_chain(base_url: str, api_key: str, model: str, model_kwargs: dict | None,
                openrouter_fallback: bool = True) -> _ChatWithFallbacks:
    extra = {"model_kwargs": model_kwargs} if model_kwargs else {}
    quota_models = _gemini_quota_fallbacks(base_url, model)
    # With quota fallbacks, a 429 should move on at once instead of the SDK retrying the same model.
    retries = {"max_retries": 0} if quota_models else {}
    common = dict(max_tokens=40000, temperature=0, **extra)

    llm = _ChatWithFallbacks(base_url=base_url, api_key=api_key, model=model, **retries, **common)
    llm.set_quota_fallbacks([
        ChatOpenAI(base_url=base_url, api_key=api_key, model=m, max_retries=0, **common) for m in quota_models
    ])
    if openrouter_fallback:
        llm.set_fallback(ChatOpenAI(
            base_url=settings.OPENROUTER_BASE_URL,
            api_key=settings.OPENROUTER_API_KEY,
            model=FALLBACK_MODEL,
            **common,
        ))
    return llm


def _make_glm(model_kwargs: dict | None = None) -> _ChatWithFallbacks:
    return _make_chain(settings.LLM_BASE_URL, settings.LLM_API_KEY, settings.CHAT_MODEL, model_kwargs)


@lru_cache(maxsize=1)
def get_chat_llm() -> _ChatWithFallbacks:
    """JSON-mode LLM for text tasks (policy extraction, compliance)."""
    return _make_glm(model_kwargs=_JSON_MODE)


@lru_cache(maxsize=1)
def get_vision_llm() -> _ChatWithFallbacks:
    """Vision LLM for receipt OCR. VISION_BASE_URL/VISION_API_KEY if set (Gemini: with the quota
    fallbacks, then OpenRouter), else OpenRouter alone."""
    if settings.VISION_BASE_URL:
        return _make_chain(settings.VISION_BASE_URL, settings.VISION_API_KEY or settings.OPENROUTER_API_KEY,
                           settings.VISION_MODEL, _JSON_MODE)
    return _make_chain(settings.OPENROUTER_BASE_URL, settings.VISION_API_KEY or settings.OPENROUTER_API_KEY,
                       settings.VISION_MODEL, _JSON_MODE, openrouter_fallback=False)


@lru_cache(maxsize=1)
def get_agent_llm() -> _ChatWithFallbacks:
    """LLM for tool-calling agent — no JSON mode (required for bind_tools)."""
    return _make_glm()


@lru_cache(maxsize=1)
def get_text_llm() -> _ChatWithFallbacks:
    """JSON-mode LLM for PDF receipt extraction."""
    return _make_glm(model_kwargs=_JSON_MODE)


@lru_cache(maxsize=1)
def get_embeddings() -> OpenAIEmbeddings:
    """Text embeddings via OpenRouter (openai/text-embedding-3-small, 1536 dims).
    30-second timeout prevents hung connections from blocking uploads indefinitely."""
    return OpenAIEmbeddings(
        base_url=settings.OPENROUTER_BASE_URL,
        api_key=settings.OPENROUTER_API_KEY,
        model=settings.EMBEDDING_MODEL,
        timeout=30,
    )
