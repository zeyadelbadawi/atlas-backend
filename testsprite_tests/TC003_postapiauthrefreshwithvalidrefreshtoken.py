import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_post_api_auth_refresh_with_valid_refresh_token():
    # Step 1: Register a new user to obtain credentials
    register_url = f"{BASE_URL}/api/auth/register"
    register_payload = {
        "email": "testuser_refresh@example.com",
        "password": "StrongPass!123",
        "name": "Test User Refresh"
    }
    headers = {"Content-Type": "application/json"}
    register_response = requests.post(register_url, json=register_payload, headers=headers, timeout=TIMEOUT)
    assert register_response.status_code == 201, f"User registration failed: {register_response.text}"

    # Step 2: Sign in with the new user to get access and refresh tokens
    signin_url = f"{BASE_URL}/api/auth/sign-in"
    signin_payload = {
        "email": register_payload["email"],
        "password": register_payload["password"]
    }
    signin_response = requests.post(signin_url, json=signin_payload, headers=headers, timeout=TIMEOUT)
    assert signin_response.status_code == 200, f"User sign-in failed: {signin_response.text}"
    signin_data = signin_response.json()
    assert "accessToken" in signin_data, "accessToken missing in sign-in response"
    assert "refreshToken" in signin_data, "refreshToken missing in sign-in response"
    refresh_token = signin_data["refreshToken"]

    # Step 3: Use refresh token to get new tokens
    refresh_url = f"{BASE_URL}/api/auth/refresh"
    refresh_headers = {"Content-Type": "application/json"}
    refresh_payload = {"refreshToken": refresh_token}
    refresh_response = requests.post(refresh_url, json=refresh_payload, headers=refresh_headers, timeout=TIMEOUT)

    # Validate response
    assert refresh_response.status_code == 200, f"Token refresh failed: {refresh_response.text}"
    refresh_data = refresh_response.json()
    assert "accessToken" in refresh_data, "accessToken missing in refresh response"
    assert "refreshToken" in refresh_data, "refreshToken missing in refresh response"
    assert refresh_data["accessToken"] != signin_data["accessToken"], "New accessToken should differ from old token"

test_post_api_auth_refresh_with_valid_refresh_token()