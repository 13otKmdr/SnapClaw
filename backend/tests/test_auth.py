import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch
import os
from datetime import datetime

from main import app
from auth import create_access_token, User, APIKey

client = TestClient(app)

# Mock database functions
@pytest.fixture
def mock_db_functions():
    with (
        patch("auth.get_user_by_email", new_callable=AsyncMock) as mock_get_user_by_email,
        patch("auth.create_user", new_callable=AsyncMock) as mock_create_user,
        patch("auth.authenticate_user", new_callable=AsyncMock) as mock_authenticate_user,
        patch("auth.verify_api_key", new_callable=AsyncMock) as mock_verify_api_key
    ):
        yield {
            "get_user_by_email": mock_get_user_by_email,
            "create_user": mock_create_user,
            "authenticate_user": mock_authenticate_user,
            "verify_api_key": mock_verify_api_key,
        }

@pytest.fixture(autouse=True)
def set_jwt_secret_key():
    # Set a dummy JWT_SECRET_KEY for testing
    with patch.dict(os.environ, {"JWT_SECRET_KEY": "test_secret_key", "APP_SECRET": "test_app_secret"}):
        yield


@pytest.mark.asyncio
async def test_register_user_success(mock_db_functions):
    mock_db_functions["get_user_by_email"].return_value = None
    mock_db_functions["create_user"].return_value = User(
        id="test_id", email="test@example.com", username="testuser", hashed_password="hashed_password", role="user"
    )

    response = client.post(
        "/api/auth/register",
        json={
            "email": "test@example.com",
            "username": "testuser",
            "password": "testpassword",
        },
    )
    assert response.status_code == 200
    assert "access_token" in response.json()
    assert response.json()["user"]["email"] == "test@example.com"

@pytest.mark.asyncio
async def test_register_user_email_exists(mock_db_functions):
    mock_db_functions["get_user_by_email"].return_value = User(
        id="existing_id", email="test@example.com", username="existinguser", hashed_password="hashed_password", role="user"
    )

    response = client.post(
        "/api/auth/register",
        json={
            "email": "test@example.com",
            "username": "newuser",
            "password": "newpassword",
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Email already registered"

@pytest.mark.asyncio
async def test_login_success(mock_db_functions):
    mock_db_functions["authenticate_user"].return_value = User(
        id="test_id", email="test@example.com", username="testuser", hashed_password="hashed_password", role="user"
    )

    response = client.post(
        "/api/auth/login",
        json={
            "email": "test@example.com",
            "password": "testpassword",
        },
    )
    assert response.status_code == 200
    assert "access_token" in response.json()
    assert response.json()["user"]["email"] == "test@example.com"

@pytest.mark.asyncio
async def test_login_invalid_credentials(mock_db_functions):
    mock_db_functions["authenticate_user"].return_value = None

    response = client.post(
        "/api/auth/login",
        json={
            "email": "wrong@example.com",
            "password": "wrongpassword",
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid credentials"

@pytest.mark.asyncio
async def test_create_api_key_success(mock_db_functions):
    mock_db_functions["verify_api_key"].return_value = APIKey(
        key="vi_testkey", name="test_key", user_id="test_id", created_at=datetime.utcnow(), permissions="[]"
    )
    # Mock get_api_key_user to return a valid user for authentication
    with patch("auth.get_api_key_user", new_callable=AsyncMock) as mock_get_api_key_user:
        mock_get_api_key_user.return_value = {"user_id": "test_id", "username": "testuser"}
        token = create_access_token({"sub": "test_id", "email": "test@example.com"})
        response = client.post(
            "/api/auth/api-keys",
            params={"name": "test_key"},
            headers={
                "Authorization": f"Bearer {token}"
            },
        )
        assert response.status_code == 200
        assert "api_key" in response.json()
        assert response.json()["name"] == "test_key"

@pytest.mark.asyncio
async def test_get_me_success(mock_db_functions):
    # Mock get_api_key_user to return a valid user for authentication
    with patch("auth.get_api_key_user", new_callable=AsyncMock) as mock_get_api_key_user:
        mock_get_api_key_user.return_value = {"user_id": "test_id", "username": "testuser", "email": "test@example.com"}
        token = create_access_token({"sub": "test_id", "email": "test@example.com"})
        response = client.get(
            "/api/auth/me",
            headers={
                "Authorization": f"Bearer {token}"
            },
        )
        assert response.status_code == 200
        assert response.json()["user_id"] == "test_id"
        assert response.json()["username"] == "testuser"

@pytest.mark.asyncio
async def test_get_me_unauthenticated(mock_db_functions):
    # Mock get_api_key_user to return None for unauthenticated user
    with patch("auth.get_api_key_user", new_callable=AsyncMock) as mock_get_api_key_user:
        mock_get_api_key_user.return_value = None
        response = client.get("/api/auth/me")
        assert response.status_code == 401
        assert response.json()["detail"] == "Not authenticated"
