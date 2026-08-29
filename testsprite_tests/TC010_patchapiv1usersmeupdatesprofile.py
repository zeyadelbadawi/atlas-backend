import requests

BASE_URL = "http://localhost:3000"
PATCH_USER_ME_ENDPOINT = "/api/v1/users/me"
REGISTER_ENDPOINT = "/api/v1/auth/register"
SIGNIN_ENDPOINT = "/api/v1/auth/sign-in"

TIMEOUT = 30

# Test user registration and authentication placeholders
TEST_USER_EMAIL = "testuser_patchprofile@example.com"
TEST_USER_PASSWORD = "StrongPassw0rd!"
TEST_USER_NAME = "Test User Patch"

def patchapiv1usersmeupdatesprofile():
    session = requests.Session()
    try:
        # Register a new user to get credentials
        register_payload = {
            "name": TEST_USER_NAME,
            "email": TEST_USER_EMAIL,
            "password": TEST_USER_PASSWORD
        }
        reg_resp = session.post(f"{BASE_URL}{REGISTER_ENDPOINT}", json=register_payload, timeout=TIMEOUT)
        assert reg_resp.status_code in (200, 201, 409), f"User registration failed: {reg_resp.text}"

        # Sign in to get JWT token
        signin_payload = {
            "email": TEST_USER_EMAIL,
            "password": TEST_USER_PASSWORD
        }
        signin_resp = session.post(f"{BASE_URL}{SIGNIN_ENDPOINT}", json=signin_payload, timeout=TIMEOUT)
        assert signin_resp.status_code == 200, f"Sign in failed: {signin_resp.text}"
        tokens = signin_resp.json()
        access_token = tokens.get("accessToken") or tokens.get("access_token")
        assert access_token, "No access token received"

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        }

        # Valid PATCH update: update name and a profile field (e.g., avatar)
        valid_update_payload = {
            "name": "Updated Test User",
            "avatar": "https://example.com/avatar.png"
        }
        patch_resp = session.patch(f"{BASE_URL}{PATCH_USER_ME_ENDPOINT}", headers=headers, json=valid_update_payload, timeout=TIMEOUT)
        assert patch_resp.status_code == 200, f"Valid patch update failed: {patch_resp.text}"
        profile = patch_resp.json()
        assert profile.get("name") == valid_update_payload["name"], "Name was not updated correctly"
        assert profile.get("avatar") == valid_update_payload["avatar"], "Avatar was not updated correctly"

        # Invalid PATCH update: send invalid payload fields (e.g., unexpected field or wrong data type)
        invalid_payloads = [
            {"nonexistent_field": "some value"},
            {"name": 12345},  # name should be string
            {"avatar": 123},  # avatar should be string (URL)
            {"name": ""},  # empty string might be invalid based on validation rules
        ]
        for invalid_payload in invalid_payloads:
            invalid_resp = session.patch(f"{BASE_URL}{PATCH_USER_ME_ENDPOINT}", headers=headers, json=invalid_payload, timeout=TIMEOUT)
            # Expecting the server to reject invalid payloads with 400
            assert invalid_resp.status_code == 400, f"Invalid payload did not return 400: payload={invalid_payload} response={invalid_resp.text}"

    finally:
        # Teardown: Delete the test user if API for user deletion exists (not specified in PRD)
        # If there is no endpoint to delete users, cleanup is skipped.
        pass

patchapiv1usersmeupdatesprofile()
