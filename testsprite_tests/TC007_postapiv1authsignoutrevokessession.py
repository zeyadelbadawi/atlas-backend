import requests

BASE_URL = "http://localhost:3000"
REGISTER_ENDPOINT = f"{BASE_URL}/api/v1/auth/register"
SIGNIN_ENDPOINT = f"{BASE_URL}/api/v1/auth/sign-in"
SIGNOUT_ENDPOINT = f"{BASE_URL}/api/v1/auth/sign-out"
REFRESH_ENDPOINT = f"{BASE_URL}/api/v1/auth/refresh"

TIMEOUT = 30


def test_post_apiv1_auth_signout_revokes_session():
    # Test user credentials
    test_user = {
        "name": "Test User SignOut",
        "email": "testsignoutuser@example.com",
        "password": "StrongPass!23"
    }

    access_token = None
    refresh_token = None

    # Register user (ignore if already exists)
    try:
        resp = requests.post(
            REGISTER_ENDPOINT,
            json={
                "name": test_user["name"],
                "email": test_user["email"],
                "password": test_user["password"]
            },
            timeout=TIMEOUT
        )
        # Accept 201 Created or 200 OK or 409 Conflict (if already registered)
        assert resp.status_code in (200, 201, 409)
    except requests.RequestException as e:
        raise AssertionError(f"Registration request failed: {e}")

    # Sign in to get access and refresh tokens
    try:
        resp = requests.post(
            SIGNIN_ENDPOINT,
            json={"email": test_user["email"], "password": test_user["password"]},
            timeout=TIMEOUT
        )
        assert resp.status_code == 200, f"Sign-in failed with status {resp.status_code}"
        data = resp.json()
        assert "accessToken" in data or "access_token" in data, "No access token in response"
        assert "refreshToken" in data or "refresh_token" in data, "No refresh token in response"
        access_token = data.get("accessToken") or data.get("access_token")
        refresh_token = data.get("refreshToken") or data.get("refresh_token")
        assert isinstance(access_token, str) and access_token
        assert isinstance(refresh_token, str) and refresh_token
    except requests.RequestException as e:
        raise AssertionError(f"Sign-in request failed: {e}")

    headers_auth = {"Authorization": f"Bearer {access_token}"}

    # Call sign-out with valid access token
    try:
        resp = requests.post(
            SIGNOUT_ENDPOINT,
            headers=headers_auth,
            timeout=TIMEOUT
        )
        assert resp.status_code == 200, f"Sign-out failed with status {resp.status_code}"
    except requests.RequestException as e:
        raise AssertionError(f"Sign-out request failed: {e}")

    # After sign-out, validate that using refresh token for refresh is invalidated
    try:
        resp = requests.post(
            REFRESH_ENDPOINT,
            json={"refreshToken": refresh_token},
            timeout=TIMEOUT
        )
        # Expect a 401 or 403 indicating invalid refresh token
        assert resp.status_code in (401, 403), (
            f"Refresh with revoked token should fail, got {resp.status_code}"
        )
    except requests.RequestException as e:
        raise AssertionError(f"Refresh request failed: {e}")


test_post_apiv1_auth_signout_revokes_session()