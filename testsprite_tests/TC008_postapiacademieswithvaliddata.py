import requests
import uuid

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# Authentication credentials for a test user with organization context.
# These should be replaced with valid credentials before running the test.
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "TestPassword123!"

def get_auth_tokens():
    """Authenticate to get access token and refresh token."""
    url = f"{BASE_URL}/api/auth/sign-in"
    payload = {
        "email": TEST_USER_EMAIL,
        "password": TEST_USER_PASSWORD
    }
    resp = requests.post(url, json=payload, timeout=TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    access_token = data.get("accessToken") or data.get("access_token")
    refresh_token = data.get("refreshToken") or data.get("refresh_token")
    assert access_token, "No access token received"
    assert refresh_token, "No refresh token received"
    return access_token, refresh_token

def create_academy(access_token, academy_data):
    url = f"{BASE_URL}/api/academies"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    resp = requests.post(url, headers=headers, json=academy_data, timeout=TIMEOUT)
    return resp

def delete_academy(access_token, academy_id):
    url = f"{BASE_URL}/api/academies/{academy_id}"
    headers = {
        "Authorization": f"Bearer {access_token}"
    }
    resp = requests.delete(url, headers=headers, timeout=TIMEOUT)
    return resp

def test_post_api_academies_with_valid_data():
    access_token, _ = get_auth_tokens()

    # Example valid academy data for creation - adjust fields as required by API schema
    unique_subdomain = f"testsubdomain-{uuid.uuid4().hex[:8]}"
    academy_data = {
        "name": "Test Academy",
        "subdomain": unique_subdomain,
        "description": "A valid test academy created by automated test",
        # Include other required fields if needed; assuming minimal required fields here
        # e.g., "websiteUrl": "https://testacademy.example.com",
        # "contactEmail": "contact@testacademy.example.com",
    }

    academy_id = None
    try:
        response = create_academy(access_token, academy_data)
        assert response.status_code == 201, f"Expected 201 Created, got {response.status_code}"
        resp_body = response.json()
        # Basic checks on response body
        assert "id" in resp_body, "Response missing academy id"
        assert resp_body["name"] == academy_data["name"], "Academy name mismatch"
        assert resp_body.get("subdomain") == academy_data["subdomain"], "Academy subdomain mismatch"
        academy_id = resp_body["id"]
    finally:
        if academy_id:
            del_response = delete_academy(access_token, academy_id)
            # It's acceptable if delete returns 204 or 200 on successful removal
            assert del_response.status_code in (200, 204), f"Failed to delete academy, status: {del_response.status_code}"

test_post_api_academies_with_valid_data()