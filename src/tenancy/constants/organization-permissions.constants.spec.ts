import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
  ORGANIZATION_MEMBER_PERMISSIONS,
  permissionsForRole,
} from './organization-permissions.constants';

/**
 * B0-WEB-04 — the plain member set (also what an academy `staff` member
 * is given) must not carry any website permission: every website API
 * refuses that tier, so a string here would only show pages that fail.
 */
describe('organization permission sets', () => {
  it('gives a plain member no website permission', () => {
    expect(
      ORGANIZATION_MEMBER_PERMISSIONS.filter((p) => p.startsWith('academy.website.')),
    ).toEqual([]);
  });

  it('falls back to the member set for an unknown role, staff included', () => {
    expect(permissionsForRole('staff')).toBe(ORGANIZATION_MEMBER_PERMISSIONS);
    expect(permissionsForRole('member')).toBe(ORGANIZATION_MEMBER_PERMISSIONS);
  });

  it('keeps the member set inside the manager set', () => {
    for (const permission of ORGANIZATION_MEMBER_PERMISSIONS) {
      expect(ORGANIZATION_MANAGER_PERMISSIONS).toContain(permission);
    }
  });

  it('keeps website viewing for managers and away from instructors', () => {
    expect(ORGANIZATION_MANAGER_PERMISSIONS).toContain('academy.website.view');
    expect(ORGANIZATION_INSTRUCTOR_PERMISSIONS).not.toContain('academy.website.view');
  });
});
