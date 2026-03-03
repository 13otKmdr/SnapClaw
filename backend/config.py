"""
Central configuration — reads from .env via python-dotenv.
All settings live here; nothing else reads os.environ directly.
"""
import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Settings:
    agent_zero_url: str
    agent_zero_api_key: str
    openai_api_key: str
    app_secret: str          # shared secret mobile uses to auth on WS connect
    tts_voice: str           # openai tts voice name
    db_path: str             # sqlite file for sessions/memory
    cors_origins: list       # list of allowed CORS origins

    @classmethod
    def from_env(cls) -> "Settings":
        app_secret = os.environ.get("APP_SECRET")
        if not app_secret:
            raise RuntimeError("APP_SECRET environment variable is not set. Insecure default values are prohibited.")
        return cls(
            agent_zero_url=os.environ.get("AGENT_ZERO_URL", "http://localhost:50001"),
            agent_zero_api_key=os.environ.get("AGENT_ZERO_API_KEY", ""),
            openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
            app_secret=app_secret,
            tts_voice=os.environ.get("TTS_VOICE", "onyx"),
            db_path=os.environ.get("DB_PATH", "voice_sessions.db"),
            cors_origins=os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://localhost:8000").split(","),
        )


# Singleton — import this everywhere
settings = Settings.from_env()
