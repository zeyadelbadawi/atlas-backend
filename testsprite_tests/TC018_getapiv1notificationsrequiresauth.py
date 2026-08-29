import requests

BASE_URL = "http://localhost:3000"
NOTIFICATIONS_PATH = "/api/v1/notifications"
TIMEOUT = 30

def test_get_apiv1_notifications_requires_auth():
    # Test unauthenticated request returns 401
    try:
        resp = requests.get(f"{BASE_URL}{NOTIFICATIONS_PATH}", timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request failed unexpectedly: {e}"
    assert resp.status_code == 401, f"Expected 401 Unauthorized without auth, got {resp.status_code}"

    # Authenticate user - register and sign in to get access token
    register_url = f"{BASE_URL}/api/v1/auth/register"
    signin_url = f"{BASE_URL}/api/v1/auth/sign-in"

    user_payload = {
        "name": "Test User TC018",
        "email": "testuser_tc018@example.com",
        "password": "TestPass123!"
    }

    try:
        # Register user, ignore 409 Conflict as user may already exist
        reg_resp = requests.post(register_url, json=user_payload, timeout=TIMEOUT)
        if reg_resp.status_code not in (200, 201, 409):
            assert False, f"User registration failed with status {reg_resp.status_code}"
    except requests.RequestException as e:
        assert False, f"User registration request failed: {e}"

    try:
        # Sign in user
        signin_payload = {
            "email": user_payload["email"],
            "password": user_payload["password"]
        }
        signin_resp = requests.post(signin_url, json=signin_payload, timeout=TIMEOUT)
        assert signin_resp.status_code == 200, f"User sign-in failed with status {signin_resp.status_code}"
        tokens = signin_resp.json()
        access_token = tokens.get("accessToken") or tokens.get("access_token")
        assert access_token, "Access token missing in sign-in response"
    except requests.RequestException as e:
        assert False, f"User sign-in request failed: {e}"

    # Access notifications endpoint with authentication
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        auth_resp = requests.get(f"{BASE_URL}{NOTIFICATIONS_PATH}", headers=headers, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Authenticated request failed: {e}"

    assert auth_resp.status_code == 200, f"Expected 200 Success with auth, got {auth_resp.status_code}"
    try:
        data = auth_resp.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    # Validate response structure: Should be a JSON object (likely with list of notifications)
    assert isinstance(data, (dict, list)), "Notifications response should be a dict or list"

# Run the test
test_get_apiv1_notifications_requires_auth()
