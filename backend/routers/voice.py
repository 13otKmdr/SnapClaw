from __future__ import annotations

import os
import logging
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from auth import get_api_key_user
from voice.stt import transcribe_audio as transcribe_audio_bytes
from voice.tts import stream_tts

log = logging.getLogger(__name__)

voice_router = APIRouter(prefix="/api/voice", tags=["Voice"])

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "z-ai/glm-5")
OPENROUTER_TEXT_MODEL = os.environ.get("OPENROUTER_TEXT_MODEL", "openai/gpt-4o-mini")
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_API_MODE = os.environ.get("OPENROUTER_API_MODE", "auto").strip().lower()
OPENROUTER_RESPONSES_MODALITIES = os.environ.get("OPENROUTER_RESPONSES_MODALITIES", "text")
ZAI_API_KEY = os.environ.get("ZAI_API_KEY", "")
ZAI_MODEL = os.environ.get("ZAI_MODEL", "glm-5")
ZAI_ASR_MODEL = os.environ.get("ZAI_ASR_MODEL", "glm-asr-2512")
ZAI_BASE_URL = os.environ.get("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4")
LOCAL_WHISPER_MODEL = os.environ.get("LOCAL_WHISPER_MODEL", "tiny.en")
LOCAL_WHISPER_DEVICE = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
LOCAL_WHISPER_COMPUTE_TYPE = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
LOCAL_WHISPER_LANGUAGE = os.environ.get("LOCAL_WHISPER_LANGUAGE", "en")
LOCAL_WHISPER_BEAM_SIZE = os.environ.get("LOCAL_WHISPER_BEAM_SIZE", "1")
LOCAL_WHISPER_ENABLED = os.environ.get("LOCAL_WHISPER_ENABLED", "true")
LLM_TIMEOUT_SECONDS = float(os.environ.get("LLM_TIMEOUT_SECONDS", "45"))
SYSTEM_PROMPT = (
    "You are a concise voice assistant. Be practical and direct. "
    "You are in a live voice conversation, so never claim you are text-only. "
    "If the user asks to run tasks, acknowledge and keep context crisp."
)

llm_client = httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS)
conversation_history: Dict[str, List[Dict[str, str]]] = {}

class OpenRouterCallError(HTTPException):
    def __init__(self, status_code: int, user_message: str, detail: Any = None):
        super().__init__(status_code=status_code, detail=detail)
        self.user_message = user_message

async def _call_openrouter_responses_with_audio(history: List[Dict[str, str]], audio_bytes: bytes, filename: str) -> str:
    # This is a placeholder for the actual OpenRouter audio processing logic.
    # The original main.py had this function, but its implementation was not provided.
    # For now, it will raise an error.
    raise OpenRouterCallError(500, "OpenRouter audio responses not implemented.")

def _model_prefers_responses(model_name: str) -> bool:
    # Placeholder for logic to check if model prefers responses
    return False

async def generate_llm_response(session_id: str, text: str) -> str:
    # Placeholder for LLM response generation
    return f"LLM response to: {text}"

def generate_response(text: str, intent: str, entities: Dict[str, Any]) -> str:
    # Placeholder for response generation based on intent and entities
    return f"Intent: {intent}, Text: {text}, Entities: {entities}"


class VoiceRequest(BaseModel):
    text: str
    session_id: str
    context: Optional[Dict[str, Any]] = None


class VoiceResponse(BaseModel):
    text: str
    intent: str
    confidence: float
    action: Optional[Dict[str, Any]] = None
    requires_confirmation: bool = False
    entities: Optional[Dict[str, Any]] = None


@voice_router.post("/process", response_model=VoiceResponse)
async def process_voice(
    request: VoiceRequest,
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    text = request.text.lower()

    intent = "CHAT"
    confidence = 0.9
    entities: Dict[str, Any] = {}
    action = None
    requires_confirmation = False

    if any(word in text for word in ["execute", "run", "agent zero", "task", "delegate"]):
        intent = "COMMAND"
        entities["action"] = "agent_execute"
        requires_confirmation = True
        action = {"type": "agent_execute", "status": "pending"}

    if intent == "CHAT":
        response_text = await generate_llm_response(request.session_id, request.text)
    else:
        response_text = generate_response(text, intent, entities)

    return VoiceResponse(
        text=response_text,
        intent=intent,
        confidence=confidence,
        action=action,
        requires_confirmation=requires_confirmation,
        entities=entities,
    )


@voice_router.post("/process-audio", response_model=VoiceResponse)
async def process_voice_audio(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Uploaded audio file is empty")

    filename = file.filename or "audio.m4a"
    entities: Dict[str, Any] = {}
    action = None
    requires_confirmation = False
    intent = "CHAT"
    confidence = 0.9

    transcript = ""
    try:
        transcript = await transcribe_audio_bytes(audio_bytes, filename)
        if transcript:
            entities["transcript"] = transcript
    except RuntimeError as exc:
        log.warning("STT unavailable in process-audio path: %s", exc)
    except Exception:
        log.exception("Unexpected STT error in process-audio path")

    text = transcript.lower() if transcript else ""
    if transcript and any(word in text for word in ["execute", "run", "agent zero", "task", "delegate"]):
        intent = "COMMAND"
        entities["action"] = "agent_execute"
        requires_confirmation = True
        action = {"type": "agent_execute", "status": "pending"}

    if intent == "COMMAND":
        response_text = generate_response(text, intent, entities)
        return VoiceResponse(
            text=response_text,
            intent=intent,
            confidence=confidence,
            action=action,
            requires_confirmation=requires_confirmation,
            entities=entities,
        )

    if OPENROUTER_API_KEY and _model_prefers_responses(OPENROUTER_MODEL):
        history = conversation_history.setdefault(session_id, [])
        history[:] = history[-12:]
        try:
            response_text = await _call_openrouter_responses_with_audio(history, audio_bytes, filename)
            history.append({"role": "user", "content": transcript or "[Voice message]"})
            history.append({"role": "assistant", "content": response_text})
            history[:] = history[-12:]
            return VoiceResponse(
                text=response_text,
                intent=intent,
                confidence=confidence,
                action=action,
                requires_confirmation=requires_confirmation,
                entities=entities,
            )
        except OpenRouterCallError as exc:
            log.warning(
                "OpenRouter audio responses failed; falling back to STT+text status=%s detail=%s filename=%s bytes=%s",
                exc.status_code,
                exc.user_message,
                filename,
                len(audio_bytes),
            )
        except Exception:
            log.exception(
                "Unexpected error in OpenRouter audio responses; falling back to STT+text filename=%s bytes=%s",
                filename,
                len(audio_bytes),
            )

    if not transcript:
        try:
            transcript = await transcribe_audio_bytes(audio_bytes, filename)
        except RuntimeError as exc:
            raise HTTPException(502, str(exc))
        if not transcript:
            raise HTTPException(502, "Transcription failed: empty transcript")
        entities["transcript"] = transcript

    response_text = await generate_llm_response(session_id, transcript)

    return VoiceResponse(
        text=response_text,
        intent=intent,
        confidence=confidence,
        action=action,
        requires_confirmation=requires_confirmation,
        entities=entities,
    )


@voice_router.get("/tts")
async def text_to_speech(text: str, voice: Optional[str] = None):
    if not text:
        raise HTTPException(400, "Text parameter is required")

    async def generate_audio():
        async for chunk in stream_tts(text, voice):
            yield chunk

    return StreamingResponse(generate_audio(), media_type="audio/mpeg")


@voice_router.post("/transcribe")
async def transcribe_audio_file(
    file: UploadFile = File(...),
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Uploaded audio file is empty")

    filename = file.filename or "audio.m4a"
    try:
        transcript = await transcribe_audio_bytes(audio_bytes, filename)
        return {"text": transcript}
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    except Exception:
        log.exception("Unexpected STT error")
        raise HTTPException(500, "Transcription failed")
