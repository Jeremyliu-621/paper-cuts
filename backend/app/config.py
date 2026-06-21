from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


@lru_cache(maxsize=1)
def load_backend_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    load_dotenv(env_path, override=False)


def env(name: str, default: str | None = None) -> str | None:
    load_backend_env()
    return os.getenv(name, default)


def required_provider_keys() -> list[str]:
    return ["OPENAI_API_KEY"]
