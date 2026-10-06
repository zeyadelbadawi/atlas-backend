import { recoveryAcademyId } from './recovery-surface.util';

const learnerOf = (academyId: string, blocked = false) => ({
  academyId,
  name: 'A',
  slug: 'a',
  host: 'a.example',
  membershipStatus: 'active',
  blocked,
});

describe('recoveryAcademyId', () => {
  it('is null without a host academy (management, local or unknown host)', () => {
    expect(
      recoveryAcademyId({ academies: [learnerOf('a-1')], academyStaff: [] }, null),
    ).toBeNull();
  });

  it("names the host academy for that academy's learner, blocked or not", () => {
    expect(
      recoveryAcademyId({ academies: [learnerOf('a-1')], academyStaff: [] }, 'a-1'),
    ).toBe('a-1');
    expect(
      recoveryAcademyId({ academies: [learnerOf('a-1', true)], academyStaff: [] }, 'a-1'),
    ).toBe('a-1');
  });

  it("names the host academy for that academy's staff", () => {
    expect(
      recoveryAcademyId(
        {
          academies: [],
          academyStaff: [{ academyId: 'a-1', role: 'owner', status: 'active' }],
        },
        'a-1',
      ),
    ).toBe('a-1');
  });

  it('never names an academy the account does not belong to', () => {
    expect(
      recoveryAcademyId(
        {
          academies: [learnerOf('a-2')],
          academyStaff: [{ academyId: 'a-3', role: 'owner', status: 'active' }],
        },
        'a-1',
      ),
    ).toBeNull();
    expect(recoveryAcademyId({ academies: [], academyStaff: [] }, 'a-1')).toBeNull();
  });
});
