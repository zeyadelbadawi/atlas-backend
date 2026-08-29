import requests

def test_get_health_endpoint_returns_service_status():
    base_url = "http://localhost:3000"
    url = f"{base_url}/health"
    headers = {
        "Accept": "application/json"
    }
    try:
        response = requests.get(url, headers=headers, timeout=30)
        # Validate status code
        assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"

        # Validate response content
        data = response.json()
        assert isinstance(data, dict), "Response is not a JSON object"

        # Database and Redis status may be nested with a 'status' field
        db_info = data.get("database")
        redis_info = data.get("redis")

        # Check if db_info and redis_info are dicts with a 'status' key
        db_status = None
        if isinstance(db_info, dict):
            db_status = db_info.get("status")
        elif isinstance(db_info, str):
            db_status = db_info

        redis_status = None
        if isinstance(redis_info, dict):
            redis_status = redis_info.get("status")
        elif isinstance(redis_info, str):
            redis_status = redis_info

        assert db_status == "up", f"Expected database status 'up', got {db_status}"
        assert redis_status == "up", f"Expected redis status 'up', got {redis_status}"

    except requests.RequestException as e:
        assert False, f"Request to /health failed: {e}"

test_get_health_endpoint_returns_service_status()
