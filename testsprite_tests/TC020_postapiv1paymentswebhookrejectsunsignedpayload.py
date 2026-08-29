import requests

def test_post_api_v1_payments_webhook_rejects_unsigned_payload():
    base_url = "http://localhost:3000"
    url = f"{base_url}/api/v1/payments/webhook"
    headers_missing_signature = {
        "Content-Type": "application/json"
        # intentionally omitting any provider signature header to simulate missing signature
    }
    headers_invalid_signature = {
        "Content-Type": "application/json",
        "X-Provider-Signature": "invalidsignaturevalue"
    }
    payload = {
        "event": "payment_intent.succeeded",
        "data": {
            "object": {
                "id": "pi_1234567890",
                "amount": 1000,
                "currency": "usd",
                "status": "succeeded"
            }
        }
    }

    # Test missing signature header
    try:
        response_missing = requests.post(url, json=payload, headers=headers_missing_signature, timeout=30)
        assert response_missing.status_code in (400, 401, 403), f"Expected 400, 401 or 403 for missing signature, got {response_missing.status_code}"
    except requests.RequestException as e:
        assert False, f"Request failed for missing signature test: {e}"

    # Test invalid signature header
    try:
        response_invalid = requests.post(url, json=payload, headers=headers_invalid_signature, timeout=30)
        assert response_invalid.status_code in (400, 401, 403), f"Expected 400, 401 or 403 for invalid signature, got {response_invalid.status_code}"
    except requests.RequestException as e:
        assert False, f"Request failed for invalid signature test: {e}"

test_post_api_v1_payments_webhook_rejects_unsigned_payload()
