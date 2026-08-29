import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_patch_api_users_me_with_valid_profile_updates():
    """Test updating authenticated user's profile with valid fields to receive 200 and updated profile."""

    # Sample user registration data to create a user for authentication
    registration_data = {
        "email": "testuser_tc006@example.com",
        "password": "SecurePass123!",
        "name": "Test User TC006"
    }

    # Fields to update in the user profile
    profile_update = {
        "name": "Updated Test User TC006",
        "avatar": "https://example.com/avatar-updated.png"
    }

    try:
        # Register a new user
        reg_resp = requests.post(
            f"{BASE_URL}/api/auth/register",
            json=registration_data,
            timeout=TIMEOUT
        )
        assert reg_resp.status_code == 201, f"User registration failed: {reg_resp.text}"

        # Sign in to get tokens
        signin_data = {
            "email": registration_data["email"],
            "password": registration_data["password"]
        }
        signin_resp = requests.post(
            f"{BASE_URL}/api/auth/sign-in",
            json=signin_data,
            timeout=TIMEOUT
        )
        assert signin_resp.status_code == 200, f"Sign-in failed: {signin_resp.text}"

        tokens = signin_resp.json()
        access_token = tokens.get("accessToken") or tokens.get("access_token")
        assert access_token, "Access token not found in sign-in response"

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json"
        }

        # Patch the user's profile with valid updates
        patch_resp = requests.patch(
            f"{BASE_URL}/api/users/me",
            headers=headers,
            json=profile_update,
            timeout=TIMEOUT
        )
        assert patch_resp.status_code == 200, f"Profile update failed: {patch_resp.text}"

        updated_profile = patch_resp.json()
        # Verify that updated fields are reflected in the response
        assert updated_profile.get("name") == profile_update["name"], "Updated name not reflected"
        assert updated_profile.get("avatar") == profile_update["avatar"], "Updated avatar not reflected"

        # Get the user profile again to confirm persisted changes
        get_resp = requests.get(
            f"{BASE_URL}/api/users/me",
            headers=headers,
            timeout=TIMEOUT
        )
        assert get_resp.status_code == 200, f"Get profile failed: {get_resp.text}"
        profile = get_resp.json()
        assert profile.get("name") == profile_update["name"], "Persisted name mismatch"
        assert profile.get("avatar") == profile_update["avatar"], "Persisted avatar mismatch"

    finally:
        # Clean up: delete the created user to not leave test data behind
        # Assuming there's an endpoint to delete current user or a platform admin API
        # Since not provided, we skip deletion or implement if available.
        pass


test_patch_api_users_me_with_valid_profile_updates()
