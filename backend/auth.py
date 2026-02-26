"""JWT-based Authentication System."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
import os


SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "your-super-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


class User(BaseModel):
    id: str
    email: EmailStr
    username: str
    role: str = "user"
    created_at: datetime = datetime.utcnow()


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


users_db: Dict[str, Dict[str, Any]] = {}
api_keys_db: Dict[str, Dict[str, Any]] = {}
sessions_db: Dict[str, Dict[str, Any]] = {}


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
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
    if not user_id or user_id not in users_db:
        raise HTTPException(status_code=401, detail="User not found")

    user_data = users_db[user_id]
    return User(**user_data)


def create_user(email: str, username: str, password: str) -> User:
    user_id = f"user_{len(users_db) + 1}"
    hashed_pw = hash_password(password)

    user = {
        "id": user_id,
        "email": email,
        "username": username,
        "hashed_password": hashed_pw,
        "role": "user",
        "created_at": datetime.utcnow().isoformat(),
    }

    users_db[user_id] = user
    return User(id=user_id, email=email, username=username, role="user")


def authenticate_user(email: str, password: str) -> Optional[User]:
    for user_data in users_db.values():
        if user_data["email"] == email and verify_password(password, user_data["hashed_password"]):
            safe = {k: v for k, v in user_data.items() if k != "hashed_password"}
            return User(**safe)
    return None


def create_api_key(user_id: str, name: str) -> str:
    import secrets

    key = f"vi_{secrets.token_urlsafe(32)}"
    api_keys_db[key] = {
        "key": key,
        "name": name,
        "user_id": user_id,
        "created_at": datetime.utcnow().isoformat(),
        "permissions": ["voice:process", "agent:execute"],
    }
    return key


def verify_api_key(key: str) -> Optional[Dict[str, Any]]:
    if key in api_keys_db:
        api_keys_db[key]["last_used"] = datetime.utcnow().isoformat()
        return api_keys_db[key]
    return None


async def get_api_key_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    api_key: Optional[str] = Query(None),
) -> Optional[Dict[str, Any]]:
    if credentials:
        token = credentials.credentials
        if token.startswith("vi_"):
            return verify_api_key(token)
        # We can call get_current_user directly, passing credentials
        # Note: get_current_user is designed as a dependency but works as a helper too
        try:
            user = await get_current_user(credentials)
            if user:
                return {"user_id": user.id, "username": user.username}
        except HTTPException:
            pass  # Fall through to check API key or return None

    if api_key:
        return verify_api_key(api_key)

    return None


async def get_authenticated_user(
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
) -> Dict[str, Any]:
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user
