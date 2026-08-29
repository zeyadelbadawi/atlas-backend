import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# Pre-existing test user credentials for authentication
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "Password123!"  # Adjust if needed


def test_get_api_addons_with_authenticated_access():
    """
    Test retrieving plan add-ons catalog with authenticated access to receive 200 and add-on list.
    """

    session = requests.Session()
    try:
        # Step 1: Sign in to get access token
        signin_url = f"{BASE_URL}/api/auth/sign-in"
        signin_payload = {
            "email": TEST_USER_EMAIL,
            "password": TEST_USER_PASSWORD
        }
        signin_resp = session.post(signin_url, json=signin_payload, timeout=TIMEOUT)
        assert signin_resp.status_code == 200, f"Sign-in failed: {signin_resp.text}"
        signin_data = signin_resp.json()
        access_token = signin_data.get("accessToken") or signin_data.get("access_token") or signin_data.get("access_token")
        assert access_token, "Access token missing in sign-in response"

        headers = {
            "Authorization": f"Bearer {access_token}"
        }

        # Step 2: Call GET /api/add-ons with auth header
        addons_url = f"{BASE_URL}/api/add-ons"
        resp = session.get(addons_url, headers=headers, timeout=TIMEOUT)
        assert resp.status_code == 200, f"Failed to get add-ons catalog: {resp.text}"

        data = resp.json()
        assert isinstance(data, list), "Response is not a list of add-ons"

    finally:
        session.close()


test_get_api_addons_with_authenticated_access()