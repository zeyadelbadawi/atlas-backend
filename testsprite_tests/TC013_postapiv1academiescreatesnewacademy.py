import requests
import uuid

BASE_URL = "http://localhost:3000"
API_PATH = "/api/v1"
TIMEOUT = 30

# Helper function to register a test user
# Generates a random email and password

def register_user():
    url_register = f"{BASE_URL}{API_PATH}/auth/register"
    email = f"testuser_{uuid.uuid4()}@example.com"
    password = "TestPassword123!"
    payload = {
        "name": "Test User",
        "email": email,
        "password": password
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    response = requests.post(url_register, json=payload, headers=headers, timeout=TIMEOUT)
    assert response.status_code in (200, 201), f"Registration failed with status {response.status_code}"
    return email, password

# Helper function to sign in a user and retrieve JWT token

def sign_in(email, password):
    url_signin = f"{BASE_URL}{API_PATH}/auth/sign-in"
    payload = {
        "email": email,
        "password": password
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    response = requests.post(url_signin, json=payload, headers=headers, timeout=TIMEOUT)
    assert response.status_code == 200, f"Sign-in failed with status {response.status_code}"
    data = response.json()
    assert "accessToken" in data, "Response missing 'accessToken'"
    token = data["accessToken"]
    return f"Bearer {token}"


def test_post_apiv1_academies_creates_new_academy():
    # Register and sign in to get a valid auth token
    email, password = register_user()
    auth_token = sign_in(email, password)

    url_create = f"{BASE_URL}{API_PATH}/academies"
    headers = {
        "Authorization": auth_token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    unique_name = f"Test Academy {uuid.uuid4()}"
    payload = {
        "name": unique_name
    }

    created_academy_id = None

    try:
        response = requests.post(url_create, json=payload, headers=headers, timeout=TIMEOUT)
        assert response.status_code == 201, f"Expected status 201, got {response.status_code}"

        data = response.json()
        assert "id" in data, "Response JSON missing 'id'"
        assert "name" in data, "Response JSON missing 'name'"
        assert data["name"] == unique_name, "Response academy name mismatch"

        created_academy_id = data["id"]

    finally:
        if created_academy_id:
            url_delete = f"{BASE_URL}{API_PATH}/academies/{created_academy_id}"
            try:
                delete_response = requests.delete(url_delete, headers=headers, timeout=TIMEOUT)
                assert delete_response.status_code in (200, 204), f"Failed to delete test academy, status {delete_response.status_code}"
            except Exception:
                pass


test_post_apiv1_academies_creates_new_academy()
