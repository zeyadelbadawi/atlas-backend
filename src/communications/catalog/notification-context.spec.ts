/**
 * Notification context isolation — every in-app event type is placed in a
 * context at creation, from the catalogue, never at read time.
 */
import {
  ACCOUNT_NOTIFICATION_KEYS,
  COMMUNICATION_CATALOG,
  notificationContextFor,
  type CommunicationEventKey,
} from './communication-catalog';
import { campaignNotificationPlacement } from '../campaigns/campaign-worker.service';

const IN_APP_KEYS = (
  Object.keys(COMMUNICATION_CATALOG) as CommunicationEventKey[]
).filter((key) => COMMUNICATION_CATALOG[key].channels.inApp !== 'never');

describe('notificationContextFor', () => {
  it.each(IN_APP_KEYS)('%s has a context (never left to the reader)', (key) => {
    const placed = notificationContextFor(key, 'academy-a');
    expect(['management', 'academy', 'account']).toContain(placed.context);
  });

  it('a learner event belongs to ITS academy', () => {
    expect(notificationContextFor('certificate.issued', 'academy-a')).toEqual({
      context: 'academy',
      academyId: 'academy-a',
    });
  });

  it('a staff event about an academy belongs to the Management dashboard, not that academy', () => {
    expect(notificationContextFor('academy.payment.submitted', 'academy-a')).toEqual({
      context: 'management',
      academyId: null,
    });
  });

  it("the account's own security notices are account-wide, whatever academy they carry", () => {
    for (const key of ACCOUNT_NOTIFICATION_KEYS) {
      expect(notificationContextFor(key, 'academy-a')).toEqual({
        context: 'account',
        academyId: null,
      });
    }
  });

  it('a learner event without an academy is unscoped (shown nowhere), never guessed', () => {
    expect(notificationContextFor('certificate.issued', null)).toEqual({
      context: 'unscoped',
      academyId: null,
    });
  });

  it('every account key is a real in-app catalogue key', () => {
    for (const key of ACCOUNT_NOTIFICATION_KEYS) {
      expect(COMMUNICATION_CATALOG[key].channels.inApp).toBe('always');
    }
  });
});

describe('campaignNotificationPlacement', () => {
  it('an academy campaign to learners belongs to that academy', () => {
    expect(
      campaignNotificationPlacement({
        scope: 'academy',
        academyId: 'academy-a',
        audience: { type: 'learners' },
      }),
    ).toEqual({ context: 'academy', academyId: 'academy-a' });
  });

  it('an academy campaign to its staff belongs to the Management dashboard', () => {
    expect(
      campaignNotificationPlacement({
        scope: 'academy',
        academyId: 'academy-a',
        audience: { type: 'staff', roles: ['manager'] },
      }),
    ).toEqual({ context: 'management', academyId: null });
  });

  it('a platform broadcast belongs to the Management dashboard', () => {
    expect(
      campaignNotificationPlacement({
        scope: 'platform',
        academyId: null,
        audience: { type: 'org_owners' },
      }),
    ).toEqual({ context: 'management', academyId: null });
  });
});
