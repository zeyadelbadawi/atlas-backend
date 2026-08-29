import requests

base_url = "http://localhost:3000"
validate_url = f"{base_url}/api/v1/auth/validate"
signin_url = f"{base_url}/api/v1/auth/sign-in"

def test_get_apiv1_auth_validate_with_and_without_jwt():
    timeout = 30
    # Valid credentials for obtaining a valid access token for test
    valid_credentials = {
        "email": "testuser@example.com",
        "password": "TestPassword123!"
    }

    # First, sign in to get a valid access token
    token = None
    try:
        signin_resp = requests.post(signin_url, json=valid_credentials, timeout=timeout)
        assert signin_resp.status_code == 200, f"Sign-in failed with status {signin_resp.status_code}"
        signin_data = signin_resp.json()
        assert 'accessToken' in signin_data or 'access_token' in signin_data, "access token not found in sign-in response"
        token = signin_data.get('accessToken') or signin_data.get('access_token')
        assert token, "Received empty access token"

        # Test GET /api/v1/auth/validate with valid access token
        headers = {"Authorization": f"Bearer {token}"}
        validate_resp = requests.get(validate_url, headers=headers, timeout=timeout)
        assert validate_resp.status_code == 200, f"Expected 200 for valid token, got {validate_resp.status_code}"

        # Test GET /api/v1/auth/validate without token
        validate_resp_no_token = requests.get(validate_url, timeout=timeout)
        assert validate_resp_no_token.status_code == 401, f"Expected 401 without token, got {validate_resp_no_token.status_code}"

        # Test GET /api/v1/auth/validate with invalid token
        headers_invalid = {"Authorization": "Bearer invalid.token.value"}
        validate_resp_invalid_token = requests.get(validate_url, headers=headers_invalid, timeout=timeout)
        assert validate_resp_invalid_token.status_code == 401, f"Expected 401 with invalid token, got {validate_resp_invalid_token.status_code}"

    except requests.RequestException as e:
        assert False, f"Request failed: {e}"

test_get_apiv1_auth_validate_with_and_without_jwt()