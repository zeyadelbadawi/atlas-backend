import requests
import time

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_get_api_v1_academies_id_not_found_for_foreign_tenant():
    timestamp = str(int(time.time() * 1000))

    try:
        # Register and sign in user for org A (caller)
        register_payload_a = {
            "name": "OrgA User",
            "email": f"orga.user.{timestamp}@example.com",
            "password": "StrongPass!123"
        }
        resp = requests.post(
            f"{BASE_URL}/api/v1/auth/register",
            json=register_payload_a,
            timeout=TIMEOUT
        )
        assert resp.status_code == 201, f"OrgA registration failed: {resp.text}"

        resp = requests.post(
            f"{BASE_URL}/api/v1/auth/sign-in",
            json={"email": register_payload_a["email"], "password": register_payload_a["password"]},
            timeout=TIMEOUT
        )
        assert resp.status_code == 200, f"OrgA sign-in failed: {resp.text}"
        token_a = resp.json().get("accessToken") or resp.json().get("access_token")
        assert token_a, "OrgA access token missing"

        headers_a = {"Authorization": f"Bearer {token_a}"}

        # Register and sign in user for org B (owner of academy)
        register_payload_b = {
            "name": "OrgB User",
            "email": f"orgb.user.{timestamp}@example.com",
            "password": "StrongPass!123"
        }
        resp = requests.post(
            f"{BASE_URL}/api/v1/auth/register",
            json=register_payload_b,
            timeout=TIMEOUT
        )
        assert resp.status_code == 201, f"OrgB registration failed: {resp.text}"

        resp = requests.post(
            f"{BASE_URL}/api/v1/auth/sign-in",
            json={"email": register_payload_b["email"], "password": register_payload_b["password"]},
            timeout=TIMEOUT
        )
        assert resp.status_code == 200, f"OrgB sign-in failed: {resp.text}"
        token_b = resp.json().get("accessToken") or resp.json().get("access_token")
        assert token_b, "OrgB access token missing"
        headers_b = {"Authorization": f"Bearer {token_b}"}

        # Get org id for org B user by getting user's memberships (assuming GET /api/v1/users/me has memberships or orgId)
        resp = requests.get(f"{BASE_URL}/api/v1/users/me", headers=headers_b, timeout=TIMEOUT)
        assert resp.status_code == 200, f"OrgB user profile fetch failed: {resp.text}"
        user_data = resp.json()
        user_org_ids = user_data.get("memberships") or user_data.get("organizations") or user_data.get("organizationIds") or []
        if isinstance(user_org_ids, list) and len(user_org_ids) > 0:
            org_b_id = user_org_ids[0].get("organizationId") if isinstance(user_org_ids[0], dict) else user_org_ids[0]
        else:
            org_b_id = user_data.get("organizationId")
        assert org_b_id, "OrgB organization ID not found for user"

        # Create an academy under org B
        academy_payload = {
            "name": "Foreign Tenant Academy",
            "organizationId": org_b_id
        }
        resp = requests.post(f"{BASE_URL}/api/v1/academies", headers=headers_b, json=academy_payload, timeout=TIMEOUT)
        assert resp.status_code == 201, f"Academy creation by org B failed: {resp.text}"
        academy_id = resp.json().get("id")
        assert academy_id, "Created academy ID missing"

        # Now user from org A tries to access academy created by org B
        resp = requests.get(f"{BASE_URL}/api/v1/academies/{academy_id}", headers=headers_a, timeout=TIMEOUT)
        # Should return 404 to avoid leaking existence
        assert resp.status_code == 404, f"Expected 404 for foreign tenant academy access, got {resp.status_code} with body {resp.text}"

    finally:
        # Cleanup: delete academy by org B user if created
        if 'token_b' in locals() and 'academy_id' in locals():
            try:
                del_resp = requests.delete(f"{BASE_URL}/api/v1/academies/{academy_id}", headers=headers_b, timeout=TIMEOUT)
            except Exception:
                pass

        # Cleanup: no API for user deletion assumed


test_get_api_v1_academies_id_not_found_for_foreign_tenant()
