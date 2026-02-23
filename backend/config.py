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

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            agent_zero_url=os.environ.get("AGENT_ZERO_URL", "http://jared-hp-elitedesk-800-g3-sff:50001"),
            agent_zero_api_key=os.environ.get("AGENT_ZERO_API_KEY", ""),
            openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
            app_secret=os.environ.get("APP_SECRET", "change-me"),
            tts_voice=os.environ.get("TTS_VOICE", "onyx"),
            db_path=os.environ.get("DB_PATH", "voice_sessions.db"),
        )


# Singleton — import this everywhere
settings = Settings.from_env()
