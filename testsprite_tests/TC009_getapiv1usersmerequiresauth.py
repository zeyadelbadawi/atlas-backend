import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_get_api_v1_users_me_requires_auth():
    # Test unauthorized access without token
    url = f"{BASE_URL}/api/v1/users/me"
    try:
        response_no_auth = requests.get(url, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to {url} without auth failed unexpectedly: {e}"
    assert response_no_auth.status_code == 401, f"Expected 401 without token, got {response_no_auth.status_code}"

    # Register a new user and sign in to get valid token for authenticated request
    register_url = f"{BASE_URL}/api/v1/auth/register"
    signin_url = f"{BASE_URL}/api/v1/auth/sign-in"

    # Use a unique email to avoid conflicts
    import uuid
    unique_email = f"testuser_{uuid.uuid4().hex[:8]}@example.com"
    password = "StrongPassword123!"

    register_payload = {
        "name": "Test User",
        "email": unique_email,
        "password": password
    }

    try:
        # Register user
        reg_resp = requests.post(register_url, json=register_payload, timeout=TIMEOUT)
        assert reg_resp.status_code in (200, 201), f"User registration failed: {reg_resp.status_code} - {reg_resp.text}"

        # Sign in user
        signin_payload = {
            "email": unique_email,
            "password": password
        }
        signin_resp = requests.post(signin_url, json=signin_payload, timeout=TIMEOUT)
        assert signin_resp.status_code == 200, f"Sign in failed: {signin_resp.status_code} - {signin_resp.text}"
        signin_data = signin_resp.json()
        access_token = signin_data.get("access_token") or signin_data.get("accessToken") or signin_data.get("accessJwt")
        assert access_token is not None, "No access token returned on sign in"

        headers = {"Authorization": f"Bearer {access_token}"}

        # Authenticated request to GET /api/v1/users/me
        resp = requests.get(url, headers=headers, timeout=TIMEOUT)
        assert resp.status_code == 200, f"Expected 200 with valid token, got {resp.status_code}"
        user_data = resp.json()
        # Basic assertions on user profile data presence
        assert "email" in user_data and user_data["email"] == unique_email, "User profile email mismatch or missing"
        assert "name" in user_data and user_data["name"] == "Test User", "User profile name mismatch or missing"
    finally:
        # Cleanup: No provided delete user endpoint, so skipping delete
        pass

test_get_api_v1_users_me_requires_auth()