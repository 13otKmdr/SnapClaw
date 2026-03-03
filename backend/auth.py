"""JWT-based Authentication System."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, Optional, List

from fastapi import Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
import os
import json
import aiosqlite
import uuid
from pathlib import Path

from sqlalchemy import create_engine, Column, String, DateTime, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()


SECRET_KEY = os.environ.get("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "JWT_SECRET_KEY environment variable is not set. Insecure default values are prohibited."
    )

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    username = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="user", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<User(id='{self.id}', email='{self.email}')>"


class APIKey(Base):
    __tablename__ = "api_keys"

    key = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    user_id = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_used = Column(DateTime, nullable=True)
    permissions = Column(Text, nullable=False)  # Stored as JSON string

    def __repr__(self):
        return f"<APIKey(key='{self.key}', user_id='{self.user_id}')>"


class UserCreate(BaseModel):
    email: EmailStr
    username: str
    password: str


class UserLogin(BaseModel):
    email: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: Dict[str, Any]


class APIKey(BaseModel):
    key: str
    name: str
    user_id: str
    created_at: datetime
    last_used: Optional[datetime] = None
    permissions: list = ["voice:process", "agent:execute"]


DB_PATH = Path(os.environ.get("DB_PATH", "voice_sessions.db"))

DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> Optional[User]:
    if not credentials:
        return None

    token = credentials.credentials
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="User not found")

    async with SessionLocal() as session:
        user = session.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
    return user


async def get_user_by_email(email: str):
    async with SessionLocal() as session:
        return session.query(User).filter(User.email == email).first()


async def create_user(email: str, username: str, password: str) -> User:
    hashed_pw = hash_password(password)
    new_user = User(
        id=str(uuid.uuid4()), email=email, username=username, hashed_password=hashed_pw
    )
    async with SessionLocal() as session:
        session.add(new_user)
        await session.commit()
        await session.refresh(new_user)
    return new_user


async def authenticate_user(email: str, password: str) -> Optional[User]:
    user = await get_user_by_email(email)
    if user and verify_password(password, user.hashed_password):
        return user
    return None


async def create_api_key(user_id: str, name: str) -> str:
    import secrets

    key = f"vi_{secrets.token_urlsafe(32)}"
    permissions = json.dumps(["voice:process", "agent:execute"])
    new_api_key = APIKey(key=key, name=name, user_id=user_id, permissions=permissions)
    async with SessionLocal() as session:
        session.add(new_api_key)
        await session.commit()
        await session.refresh(new_api_key)
    return new_api_key.key


async def verify_api_key(key: str) -> Optional[APIKey]:
    async with SessionLocal() as session:
        api_key = session.query(APIKey).filter(APIKey.key == key).first()
        if api_key:
            api_key.last_used = datetime.utcnow()
            await session.commit()
            await session.refresh(api_key)
            return api_key
        return None


async def get_api_key_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    api_key_str: Optional[str] = Query(None, alias="api_key"),
) -> Optional[Dict[str, Any]]:
    if credentials:
        token = credentials.credentials
        if token.startswith("vi_"):
            api_key_obj = await verify_api_key(token)
            if api_key_obj:
                return {
                    "user_id": api_key_obj.user_id,
                    "permissions": json.loads(api_key_obj.permissions),
                }
        try:
            user = await get_current_user(credentials)
            if user:
                return {
                    "user_id": user.id,
                    "username": user.username,
                    "permissions": ["voice:process", "agent:execute"],
                }
        except HTTPException:
            pass

    if api_key_str:
        api_key_obj = await verify_api_key(api_key_str)
        if api_key_obj:
            return {
                "user_id": api_key_obj.user_id,
                "permissions": json.loads(api_key_obj.permissions),
            }

    return None


async def get_authenticated_user(
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
) -> Dict[str, Any]:
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user
