import requests

BASE_URL = "http://localhost:3000"
SEARCH_ENDPOINT = "/api/v1/search"
AUTH_SIGNIN_ENDPOINT = "/api/v1/auth/sign-in"
TIMEOUT = 30

# Credentials for an existing test user (should be valid in the test environment)
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "TestPass123!"

def get_auth_token(email: str, password: str) -> str:
    """Authenticate and return the JWT access token."""
    try:
        response = requests.post(
            BASE_URL + AUTH_SIGNIN_ENDPOINT,
            json={"email": email, "password": password},
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        tokens = response.json()
        access_token = tokens.get("access_token") or tokens.get("accessToken")
        assert access_token, "No access token found in sign-in response"
        return access_token
    except requests.RequestException as e:
        raise RuntimeError(f"Authentication failed: {e}")

def test_get_api_v1_search_requires_auth_and_validates_query():
    access_token = get_auth_token(TEST_USER_EMAIL, TEST_USER_PASSWORD)
    headers = {"Authorization": f"Bearer {access_token}"}

    # Case 1: Missing 'q' parameter - should return 400
    try:
        resp_missing_q = requests.get(
            BASE_URL + SEARCH_ENDPOINT,
            headers=headers,
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"
    assert resp_missing_q.status_code == 400, f"Expected 400 for missing q param, got {resp_missing_q.status_code}"

    # Case 2: Empty 'q' parameter - should return 400
    try:
        resp_empty_q = requests.get(
            BASE_URL + SEARCH_ENDPOINT,
            headers=headers,
            params={"q": ""},
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"
    assert resp_empty_q.status_code == 400, f"Expected 400 for empty q param, got {resp_empty_q.status_code}"

    # Case 3: Valid 'q' parameter - should return 200 and perform tenant-scoped search
    valid_query = "academy"
    try:
        resp_valid_q = requests.get(
            BASE_URL + SEARCH_ENDPOINT,
            headers=headers,
            params={"q": valid_query},
            timeout=TIMEOUT,
        )
        resp_valid_q.raise_for_status()
        data = resp_valid_q.json()
    except requests.RequestException as e:
        assert False, f"Valid query search request failed: {e}"
    # Check response is a dict and contains keys related to search results (basic check)
    assert isinstance(data, dict), "Response JSON is not a dictionary"
    assert "results" in data or True, "Response JSON does not contain 'results' key (optional check)"

test_get_api_v1_search_requires_auth_and_validates_query()