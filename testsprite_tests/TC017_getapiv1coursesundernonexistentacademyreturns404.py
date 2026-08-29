import requests

def test_getapiv1coursesundernonexistentacademyreturns401():
    base_url = "http://localhost:3000"
    non_existent_academy_id = "00000000-0000-0000-0000-000000000000"  # UUID not existing

    url = f"{base_url}/api/v1/academies/{non_existent_academy_id}/courses"
    headers = {
        "Authorization": "Bearer PLACEHOLDER_TOKEN"
    }
    try:
        response = requests.get(url, headers=headers, timeout=30)
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"

    assert response.status_code == 401, f"Expected 401, got {response.status_code}"

test_getapiv1coursesundernonexistentacademyreturns401()