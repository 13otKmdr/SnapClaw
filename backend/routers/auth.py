from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import (
    Token,
    UserCreate,
    UserLogin,
    authenticate_user,
    create_access_token,
    create_api_key,
    create_user,
    get_api_key_user,
    get_user_by_email,
)

auth_router = APIRouter(prefix="/api/auth", tags=["Auth"])


@auth_router.post("/register", response_model=Token)
async def register(user_data: UserCreate):
    if await get_user_by_email(user_data.email):
        raise HTTPException(400, "Email already registered")

    user = await create_user(user_data.email, user_data.username, user_data.password)
    token = create_access_token({"sub": user.id, "email": user.email})

    return Token(
        access_token=token,
        user={"id": user.id, "email": user.email, "username": user.username},
    )


@auth_router.post("/login", response_model=Token)
async def login(credentials: UserLogin):
    user = await authenticate_user(credentials.email, credentials.password)
    if not user:
        raise HTTPException(401, "Invalid credentials")

    token = create_access_token({"sub": user.id, "email": user.email})

    return Token(
        access_token=token,
        user={"id": user.id, "email": user.email, "username": user.username},
    )


@auth_router.post("/api-keys")
async def create_new_api_key(
    name: str,
    current_user: Dict[str, Any] = Depends(get_api_key_user),
):
    if not current_user:
        raise HTTPException(401, "Authentication required")

    key = await create_api_key(current_user["user_id"], name)
    return {"api_key": key, "name": name}


@auth_router.get("/me")
async def get_me(current_user: Dict[str, Any] = Depends(get_api_key_user)):
    if not current_user:
        raise HTTPException(401, "Not authenticated")
    return current_user
