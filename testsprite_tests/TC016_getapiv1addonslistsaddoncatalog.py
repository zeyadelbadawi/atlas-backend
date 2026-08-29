import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

# You must replace 'your_valid_jwt_token_here' with a real valid JWT token string before running the test
AUTH_TOKEN = "your_valid_jwt_token_here"

def test_get_api_v1_add_ons_returns_addon_catalog():
    url = f"{BASE_URL}/api/v1/add-ons"
    headers = {
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "Accept": "application/json"
    }
    try:
        response = requests.get(url, headers=headers, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"

    assert response.status_code == 200, f"Expected status 200 but got {response.status_code}"

    try:
        data = response.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    assert data is not None, "Response JSON is None"
    assert (isinstance(data, dict) and data) or (isinstance(data, list) and len(data) > 0), \
        "Add-on catalog response is empty or invalid"

test_get_api_v1_add_ons_returns_addon_catalog()