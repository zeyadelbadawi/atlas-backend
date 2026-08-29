import requests

def test_post_apiv1_auth_signin_with_invalid_credentials():
    base_url = "http://localhost:3000"
    url = f"{base_url}/api/v1/auth/sign-in"
    headers = {
        "Content-Type": "application/json"
    }
    # Using an email (both existing or non-existing) to verify generic 401 response
    payloads = [
        {"email": "knownuser@example.com", "password": "WrongPassword123!"},
        {"email": "nonexistentuser@example.com", "password": "AnyWrongPassword!"}
    ]

    timeout = 30

    for payload in payloads:
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=timeout)
        except requests.RequestException as e:
            assert False, f"Request failed: {e}"

        assert response.status_code == 401, (
            f"Expected status code 401, but got {response.status_code} for payload: {payload}"
        )

        # Assert the response content does not leak if email exists or not.
        # The error message should be generic, so it should NOT reveal existence.
        # Thus, response must not mention "user not found", "email does not exist", "invalid email" etc.
        text = response.text.lower()
        assert "email" not in text or "exists" not in text or "not found" not in text or "user" not in text, \
            f"Response leaked user info: {response.text}"

test_post_apiv1_auth_signin_with_invalid_credentials()