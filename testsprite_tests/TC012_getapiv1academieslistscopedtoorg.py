import requests

BASE_URL = "http://localhost:3000"
TOKEN = "INSERT_VALID_JWT_HERE"  # Replace with a valid JWT of a user
TIMEOUT = 30


def test_get_apiv1_academies_list_scoped_to_org():
    url = f"{BASE_URL}/api/v1/academies"
    headers_auth = {
        "Authorization": f"Bearer {TOKEN}"
    }
    headers_no_auth = {}

    # Attempt an unauthenticated request, expecting 401 Unauthorized
    resp_unauth = requests.get(url, headers=headers_no_auth, timeout=TIMEOUT)
    assert resp_unauth.status_code == 401, f"Expected 401 Unauthorized, got {resp_unauth.status_code}"

    # Authenticated request to get academies
    resp_auth = requests.get(url, headers=headers_auth, timeout=TIMEOUT)
    assert resp_auth.status_code == 200, f"Expected 200 OK, got {resp_auth.status_code}"

    academies = resp_auth.json()
    assert isinstance(academies, list), "Expected response body to be a list"

    # Validate each academy belongs to the authenticated user's organization
    # Since we lack user/org context in test, check presence of organizationId field per academy
    # and that it is consistent among all academies returned (tenant scoping).
    if academies:
        org_ids = {academy.get("organizationId") for academy in academies if "organizationId" in academy}
        assert len(org_ids) == 1, "Returned academies belong to more than one organization"
        # Further validation if needed could be done here


test_get_apiv1_academies_list_scoped_to_org()