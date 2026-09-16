/**
 * What each academy member role costs (P62).
 *
 * WHY THIS TEST EXISTS. The `staff` plan limit had a number, a usage
 * counter and a dashboard row, and no enforcement anywhere — because
 * enforcement lived at each call site and one role simply never got one.
 * The mapping is now total over `AcademyMemberRole`, and this pins it, so
 * "which roles cost a seat" is a decision recorded in a test rather than an
 * accident of which call sites remembered.
 *
 * A new role added to the Prisma enum fails to COMPILE against
 * `Record<AcademyMemberRole, ...>` before it ever reaches this file; this
 * catches the other half — a role silently re-pointed at the wrong limit.
 */
import { MEMBER_ROLE_LIMIT } from './academies.service';
import type { AcademyMemberRole } from '@prisma/client';

const ALL_ROLES: AcademyMemberRole[] = [
  'owner',
  'administrator',
  'manager',
  'instructor',
  'staff',
];

describe('MEMBER_ROLE_LIMIT', () => {
  it('covers every role in the enum', () => {
    for (const role of ALL_ROLES) {
      expect(Object.prototype.hasOwnProperty.call(MEMBER_ROLE_LIMIT, role)).toBe(true);
    }
    expect(Object.keys(MEMBER_ROLE_LIMIT).sort()).toEqual([...ALL_ROLES].sort());
  });

  it('charges an instructor against the instructors limit', () => {
    expect(MEMBER_ROLE_LIMIT.instructor).toBe('instructors');
  });

  it('charges staff against the staff limit — the gap this closes', () => {
    expect(MEMBER_ROLE_LIMIT.staff).toBe('staff');
  });

  it('charges nothing for owner, administrator or manager', () => {
    // Deliberate, not missing: `computeLiveCounts` counts only the
    // literally-matching role, so these three are measured by neither
    // `instructors` nor `staff`. Enforcing a limit that usage does not
    // measure would refuse writes against a number no dashboard explains.
    expect(MEMBER_ROLE_LIMIT.owner).toBeNull();
    expect(MEMBER_ROLE_LIMIT.administrator).toBeNull();
    expect(MEMBER_ROLE_LIMIT.manager).toBeNull();
  });

  it('never points a role at a limit that is not a real count-based key', () => {
    // `generalStorage`/`videoStorage` are byte-precise and go through
    // `assertStorageWithinLimit`; `recordedSessions` has its own serialized
    // quota. None of them can be charged per member.
    const allowed = new Set(['instructors', 'staff', null]);
    for (const role of ALL_ROLES) {
      expect(allowed.has(MEMBER_ROLE_LIMIT[role])).toBe(true);
    }
  });
});
