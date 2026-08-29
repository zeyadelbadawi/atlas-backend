import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# Replace these with valid credentials for an authenticated user with organization context
USER_EMAIL = "testuser@example.com"
USER_PASSWORD = "TestPassword123!"

def authenticate():
    """Authenticate and return access token"""
    url = f"{BASE_URL}/api/auth/sign-in"
    payload = {
        "email": USER_EMAIL,
        "password": USER_PASSWORD
    }
    response = requests.post(url, json=payload, timeout=TIMEOUT)
    response.raise_for_status()
    data = response.json()
    assert "accessToken" in data, "No accessToken in auth response"
    return data["accessToken"]

def test_get_api_academies_with_organization_context():
    access_token = authenticate()
    headers = {
        "Authorization": f"Bearer {access_token}"
    }

    url = f"{BASE_URL}/api/academies"
    try:
        response = requests.get(url, headers=headers, timeout=TIMEOUT)
        # Validate response status code
        assert response.status_code == 200, f"Expected status 200, got {response.status_code}"

        data = response.json()

        # Validate that response is a list (academy list)
        assert isinstance(data, list), "Response should be a list of academies"

        # Optionally validate structure of each academy item if any exist
        if data:
            academy = data[0]
            # Common expected keys in academy objects (based on typical academy object)
            expected_keys = {"id", "name", "organizationId", "createdAt", "updatedAt"}
            missing_keys = expected_keys - academy.keys()
            assert not missing_keys, f"Missing keys in academy object: {missing_keys}"

    except requests.exceptions.RequestException as e:
        assert False, f"HTTP request failed: {e}"

test_get_api_academies_with_organization_context()