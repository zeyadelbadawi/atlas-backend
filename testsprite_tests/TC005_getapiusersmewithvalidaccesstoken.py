import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# Dummy user credentials for sign-in to obtain a valid token
USER_EMAIL = "testuser@example.com"
USER_PASSWORD = "TestPassword123!"


def test_get_api_users_me_with_valid_access_token():
    # First, sign-in to get an access token
    sign_in_url = f"{BASE_URL}/api/auth/sign-in"
    sign_in_payload = {
        "email": USER_EMAIL,
        "password": USER_PASSWORD
    }
    try:
        sign_in_response = requests.post(sign_in_url, json=sign_in_payload, timeout=TIMEOUT)
        assert sign_in_response.status_code == 200, f"Sign-in failed with status {sign_in_response.status_code}"
        tokens = sign_in_response.json()
        access_token = tokens.get("access_token")
        assert access_token, "access_token not found in sign-in response"

        # Use the access token to get the authenticated user's profile
        users_me_url = f"{BASE_URL}/api/users/me"
        headers = {
            "Authorization": f"Bearer {access_token}"
        }
        get_profile_response = requests.get(users_me_url, headers=headers, timeout=TIMEOUT)
        assert get_profile_response.status_code == 200, f"GET /api/users/me failed with status {get_profile_response.status_code}"

        profile_data = get_profile_response.json()
        # Validate expected fields in user profile (basic structure checks)
        assert isinstance(profile_data, dict), "Profile data is not a JSON object"
        # Check some common expected fields in user profile
        expected_keys = {"id", "email", "name"}
        assert expected_keys.issubset(profile_data.keys()), f"Profile missing keys: {expected_keys - profile_data.keys()}"

    except requests.RequestException as e:
        assert False, f"RequestException occurred: {e}"


test_get_api_users_me_with_valid_access_token()