import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# Assumed test user credentials for authentication
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "TestPassword123!"

def get_access_token():
    """Authenticate and return access token for the test user."""
    signin_url = f"{BASE_URL}/api/auth/sign-in"
    payload = {
        "email": TEST_USER_EMAIL,
        "password": TEST_USER_PASSWORD
    }
    try:
        response = requests.post(signin_url, json=payload, timeout=TIMEOUT)
        response.raise_for_status()
        data = response.json()
        assert "accessToken" in data, "accessToken not in response"
        return data["accessToken"]
    except requests.RequestException as e:
        raise RuntimeError(f"Failed to sign in: {e}")
    except AssertionError as e:
        raise RuntimeError(f"Invalid sign-in response: {e}")

def test_get_api_plans_with_authenticated_access():
    access_token = get_access_token()
    headers = {
        "Authorization": f"Bearer {access_token}"
    }
    plans_url = f"{BASE_URL}/api/plans"

    try:
        response = requests.get(plans_url, headers=headers, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise RuntimeError(f"Request to get plans failed: {e}")

    assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"
    
    try:
        data = response.json()
    except ValueError:
        raise AssertionError("Response is not valid JSON")

    assert isinstance(data, list), "Expected response body to be a list of plans"

    # Optional deeper validation could be added here if schema of plans known
    # For example check that each plan has keys like 'id', 'key', 'name', etc.
    for plan in data:
        assert isinstance(plan, dict), "Each plan should be a dictionary"
        assert "key" in plan, "Plan missing 'key'"
        assert "name" in plan, "Plan missing 'name'"

test_get_api_plans_with_authenticated_access()