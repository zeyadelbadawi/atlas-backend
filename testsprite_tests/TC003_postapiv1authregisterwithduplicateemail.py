import requests
import uuid

BASE_URL = "http://localhost:3000"
REGISTER_ENDPOINT = "/api/v1/auth/register"
TIMEOUT = 30


def test_postapiv1authregisterwithduplicateemail():
    # Generate a unique email to register first
    test_email = f"testuser_{uuid.uuid4().hex}@example.com"
    password = "TestPassword123!"
    name = "Test User"

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    payload = {
        "name": name,
        "email": test_email,
        "password": password
    }

    # First registration attempt (should succeed)
    try:
        response = requests.post(
            f"{BASE_URL}{REGISTER_ENDPOINT}",
            json=payload,
            headers=headers,
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        assert False, f"Initial registration request failed: {e}"

    assert response.status_code in (200, 201), f"Expected 200 or 201 on first registration but got {response.status_code}"

    # Second registration attempt with the same email (should fail with 409 or 400)
    try:
        duplicate_response = requests.post(
            f"{BASE_URL}{REGISTER_ENDPOINT}",
            json=payload,
            headers=headers,
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        assert False, f"Duplicate registration request failed: {e}"

    assert duplicate_response.status_code in (400, 409), (
        f"Expected 400 or 409 on duplicate registration but got {duplicate_response.status_code}"
    )

    # Optionally check error message structure if returned as JSON and meaningful
    try:
        error_payload = duplicate_response.json()
        # Expect an error key or similar conflict message
        assert (
            isinstance(error_payload, dict)
            and ("error" in error_payload or "message" in error_payload)
        )
    except Exception:
        # If response is not JSON or no content, just pass as the status code suffices
        pass


test_postapiv1authregisterwithduplicateemail()