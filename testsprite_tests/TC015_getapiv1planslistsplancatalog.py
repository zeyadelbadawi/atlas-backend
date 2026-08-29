import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# Replace these with valid credentials for an authenticated user in the system
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "TestPass123!"

def get_auth_token():
    signin_url = f"{BASE_URL}/api/v1/auth/sign-in"
    payload = {
        "email": TEST_USER_EMAIL,
        "password": TEST_USER_PASSWORD
    }
    try:
        resp = requests.post(signin_url, json=payload, timeout=TIMEOUT)
        resp.raise_for_status()
        tokens = resp.json()
        access_token = tokens.get("accessToken") or tokens.get("access_token") or tokens.get("access_token")
        if not access_token:
            raise Exception("Access token not found in sign-in response")
        return access_token
    except requests.RequestException as e:
        raise Exception(f"Authentication failed: {e}")

def test_get_api_v1_plans_lists_plan_catalog():
    access_token = get_auth_token()

    url = f"{BASE_URL}/api/v1/plans"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json"
    }

    try:
        response = requests.get(url, headers=headers, timeout=30)
        # Validate HTTP status code 200
        assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"

        json_data = response.json()
        # Validate response is a dict containing subscription plans catalog
        assert isinstance(json_data, dict) or isinstance(json_data, list), "Response JSON should be a dict or list"

        # Further validate that at least one plan exists in catalog if list
        if isinstance(json_data, list):
            assert len(json_data) > 0, "Plan catalog is empty"
            for plan in json_data:
                assert "key" in plan or "id" in plan, "Plan should have 'key' or 'id'"
                assert "name" in plan, "Plan should have a 'name'"
        elif isinstance(json_data, dict):
            # If dict, we expect some key like "plans" containing list
            if "plans" in json_data:
                plans = json_data["plans"]
                assert isinstance(plans, list), "'plans' should be a list"
                assert len(plans) > 0, "Plan catalog under 'plans' is empty"
                for plan in plans:
                    assert "key" in plan or "id" in plan, "Plan should have 'key' or 'id'"
                    assert "name" in plan, "Plan should have a 'name'"
            else:
                # If no 'plans' key, check fields directly
                assert "key" in json_data or "id" in json_data, "Plan catalog dict missing 'key' or 'id'"
                assert "name" in json_data, "Plan catalog dict missing 'name'"

    except requests.RequestException as e:
        assert False, f"Request failed: {e}"
    except ValueError:
        assert False, "Response could not be decoded as JSON"

test_get_api_v1_plans_lists_plan_catalog()
