import requests

def test_post_api_auth_sign_in_with_valid_credentials():
    base_url = "http://localhost:3000"
    endpoint = "/api/auth/sign-in"
    url = base_url + endpoint
    timeout_seconds = 30
    
    # Example valid credentials - these must exist in the test system for the test to pass
    payload = {
        "email": "validuser@example.com",
        "password": "ValidPassword123!"
    }
    
    headers = {
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=timeout_seconds)
    except requests.RequestException as e:
        assert False, f"HTTP request failed: {e}"
    
    assert response.status_code == 200, f"Expected status code 200 but got {response.status_code}"
    
    try:
        json_response = response.json()
    except ValueError:
        assert False, "Response is not a valid JSON"
    
    # Expect keys 'accessToken' and 'refreshToken' inside the JSON response
    assert "accessToken" in json_response, "Response JSON missing 'accessToken'"
    assert isinstance(json_response["accessToken"], str), "'accessToken' is not a string"
    assert json_response["accessToken"], "'accessToken' is empty"
    
    assert "refreshToken" in json_response, "Response JSON missing 'refreshToken'"
    assert isinstance(json_response["refreshToken"], str), "'refreshToken' is not a string"
    assert json_response["refreshToken"], "'refreshToken' is empty"

test_post_api_auth_sign_in_with_valid_credentials()
