import requests

BASE_URL = "http://localhost:3000"
REGISTER_URL = f"{BASE_URL}/api/v1/auth/register"
SIGNIN_URL = f"{BASE_URL}/api/v1/auth/sign-in"
REFRESH_URL = f"{BASE_URL}/api/v1/auth/refresh"
TIMEOUT = 30

def test_post_apiv1_auth_refresh_with_valid_refresh_token():
    try:
        # Step 1: Register a new user to obtain valid credentials
        register_payload = {
            "name": "Test User Refresh",
            "email": "testuserrefresh@example.com",
            "password": "StrongPassword123!"
        }
        reg_resp = requests.post(REGISTER_URL, json=register_payload, timeout=TIMEOUT)
        assert reg_resp.status_code in (200, 201), f"User registration failed: {reg_resp.text}"

        # Step 2: Sign in with the registered user credentials to get access and refresh tokens
        signin_payload = {
            "email": register_payload["email"],
            "password": register_payload["password"]
        }
        signin_resp = requests.post(SIGNIN_URL, json=signin_payload, timeout=TIMEOUT)
        assert signin_resp.status_code == 200, f"Sign-in failed: {signin_resp.text}"
        signin_json = signin_resp.json()
        assert "accessToken" in signin_json, "accessToken missing in sign-in response"
        assert "refreshToken" in signin_json, "refreshToken missing in sign-in response"
        refresh_token = signin_json["refreshToken"]

        # Step 3: Refresh token using the valid refresh token
        refresh_payload = {"refreshToken": refresh_token}
        refresh_resp = requests.post(REFRESH_URL, json=refresh_payload, timeout=TIMEOUT)
        assert refresh_resp.status_code == 200, f"Refresh token request failed: {refresh_resp.text}"

        refresh_json = refresh_resp.json()
        assert "accessToken" in refresh_json, "accessToken missing in refresh response"
        assert refresh_json["accessToken"] != signin_json["accessToken"], "accessToken did not change on refresh"
    finally:
        # Cleanup: No explicit sign-out or deletion endpoint for test user specified in PRD for auth/register; 
        # Therefore no cleanup is performed here.
        pass

test_post_apiv1_auth_refresh_with_valid_refresh_token()