import requests
import uuid

BASE_URL = "http://localhost:3000"
REGISTER_ENDPOINT = "/api/auth/register"

def test_post_api_auth_register_with_valid_data():
    url = BASE_URL + REGISTER_ENDPOINT
    # Prepare valid registration data; using a random email to avoid conflicts
    unique_email = f"testuser_{uuid.uuid4().hex[:8]}@example.com"
    payload = {
        "email": unique_email,
        "password": "ValidPassw0rd!",
        "firstName": "Test",
        "lastName": "User"
    }
    headers = {
        "Content-Type": "application/json"
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        # Assert the response status code is 201 Created
        assert response.status_code == 201, f"Expected status code 201, got {response.status_code}"
        # Assert the response contains minimal user data indicating creation
        response_json = response.json()
        assert 'id' in response_json or 'userId' in response_json, "Response JSON missing user identifier"
        assert response_json.get('email', '').lower() == unique_email.lower(), "Registered email does not match"
    except requests.exceptions.RequestException as e:
        assert False, f"Request to register user failed: {e}"

test_post_api_auth_register_with_valid_data()
