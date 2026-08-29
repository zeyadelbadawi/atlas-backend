import requests

BASE_URL = "http://localhost:3000"
PASSWORD_ENDPOINT = "/api/v1/users/me/password"
LOGIN_ENDPOINT = "/api/v1/auth/sign-in"
USER_ME_ENDPOINT = "/api/v1/users/me"
TIMEOUT = 30

# Test user credentials (should exist in system for test)
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "CorrectPassword123!"
WRONG_CURRENT_PASSWORD = "WrongPassword123!"
NEW_PASSWORD = "NewPassword456!"


def test_post_api_v1_users_me_password_with_wrong_current_password():
    session = requests.Session()

    try:
        # Sign in the user to get access token
        login_resp = session.post(
            BASE_URL + LOGIN_ENDPOINT,
            json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
            timeout=TIMEOUT,
        )
        assert login_resp.status_code == 200, f"Login failed: {login_resp.text}"
        tokens = login_resp.json()
        access_token = tokens.get("accessToken") or tokens.get("access_token") or tokens.get("access_token")
        assert access_token, "Access token not returned on login"

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

        # Store current password for later revert if needed (but no real password change expected)
        # Attempt to change password with wrong current password
        password_change_payload = {
            "currentPassword": WRONG_CURRENT_PASSWORD,
            "newPassword": NEW_PASSWORD,
        }
        resp = session.post(
            BASE_URL + PASSWORD_ENDPOINT,
            json=password_change_payload,
            headers=headers,
            timeout=TIMEOUT,
        )
        # Assert response status is 400 or 403
        assert resp.status_code in (400, 403), (
            f"Expected 400 or 403 status for wrong current password, got {resp.status_code}: {resp.text}"
        )

        # Confirm password is NOT changed by verifying that login with OLD password still works
        login_resp_after = session.post(
            BASE_URL + LOGIN_ENDPOINT,
            json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
            timeout=TIMEOUT,
        )
        assert login_resp_after.status_code == 200, "Password changed despite wrong current password"

    finally:
        session.close()


test_post_api_v1_users_me_password_with_wrong_current_password()