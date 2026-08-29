import requests

BASE_URL = "http://localhost:3000"
REGISTER_URL = f"{BASE_URL}/api/auth/register"
SIGNIN_URL = f"{BASE_URL}/api/auth/sign-in"
SIGNOUT_URL = f"{BASE_URL}/api/auth/sign-out"
VALIDATE_URL = f"{BASE_URL}/api/auth/validate"
TIMEOUT = 30

def test_post_api_auth_sign_out_with_valid_access_token():
    # Register new user for login
    registration_payload = {
        "email": "testuser_signout@example.com",
        "password": "TestPassword123!"
    }

    try:
        reg_resp = requests.post(REGISTER_URL, json=registration_payload, timeout=TIMEOUT)
        assert reg_resp.status_code == 201, f"Registration failed: {reg_resp.text}"

        # Sign in to get tokens
        signin_payload = {
            "email": registration_payload["email"],
            "password": registration_payload["password"],
        }
        signin_resp = requests.post(SIGNIN_URL, json=signin_payload, timeout=TIMEOUT)
        assert signin_resp.status_code == 200, f"Sign-in failed: {signin_resp.text}"
        signin_data = signin_resp.json()
        access_token = signin_data.get("access_token")
        assert access_token, "Access token not found in sign-in response"

        headers = {"Authorization": f"Bearer {access_token}"}

        # Call sign-out endpoint with valid access token
        signout_resp = requests.post(SIGNOUT_URL, headers=headers, timeout=TIMEOUT)
        assert signout_resp.status_code == 200, f"Sign-out failed: {signout_resp.text}"

        # Validate that token is revoked by calling validate endpoint
        validate_resp = requests.get(VALIDATE_URL, headers=headers, timeout=TIMEOUT)
        assert validate_resp.status_code in (401, 403), "Token should be revoked and validation should fail"

    finally:
        # Cleanup no explicit delete endpoint for user in PRD, so nothing to delete here.
        pass

test_post_api_auth_sign_out_with_valid_access_token()
