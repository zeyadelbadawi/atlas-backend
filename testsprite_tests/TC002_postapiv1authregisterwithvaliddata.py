import requests
import uuid

BASE_URL = "http://localhost:3000"
REGISTER_ENDPOINT = "/api/v1/auth/register"
TIMEOUT = 30

def test_postapiv1authregisterwithvaliddata():
    url = BASE_URL + REGISTER_ENDPOINT
    unique_email = f"testuser_{uuid.uuid4().hex}@example.com"
    payload = {
        "name": "Test User",
        "email": unique_email,
        "password": "Str0ngP@ssw0rd!"
    }
    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=TIMEOUT)
        assert response.status_code == 201, f"Expected status code 201, got {response.status_code}"
        content_type = response.headers.get('Content-Type', '')
        assert 'application/json' in content_type.lower(), f"Expected 'application/json' content type, got {content_type}"
        assert response.text.strip() != "", "Response body is empty"
        data = response.json()
        assert "id" in data, "Response JSON does not contain 'id'"
        assert data.get("name") == payload["name"], f"Expected name '{payload['name']}', got '{data.get('name')}'"
        assert data.get("email") == payload["email"], f"Expected email '{payload['email']}', got '{data.get('email')}'"
        # Password should not be returned in response for security best practices
        assert "password" not in data, "Response should not contain 'password' field"
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"
    except ValueError as e:
        assert False, f"Failed to decode JSON: {e}"

test_postapiv1authregisterwithvaliddata()
