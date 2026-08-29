import requests

def test_post_api_v1_auth_signin_with_valid_credentials():
    base_url = "http://localhost:3000"
    url = f"{base_url}/api/v1/auth/sign-in"
    timeout = 30

    # Example valid credentials for sign-in; adjust as needed for your test environment
    payload = {
        "email": "validuser@example.com",
        "password": "ValidPassword123!"
    }

    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    except requests.RequestException as e:
        assert False, f"Request failed with exception: {e}"

    assert response.status_code == 200, f"Expected status code 200 but got {response.status_code}"
    try:
        data = response.json()
    except ValueError:
        assert False, "Response is not JSON"

    assert "accessToken" in data and isinstance(data["accessToken"], str) and len(data["accessToken"]) > 0, \
        "Response JSON missing or invalid 'accessToken'"
    assert "refreshToken" in data and isinstance(data["refreshToken"], str) and len(data["refreshToken"]) > 0, \
        "Response JSON missing or invalid 'refreshToken'"

test_post_api_v1_auth_signin_with_valid_credentials()
