/**
 * `credentialValues` — which outbox `values` are live credentials, and the
 * pure helper the dispatcher uses to strip them once a row settles.
 * The end-to-end proof (a real dispatch, a real row) is in
 * `test/email-verification-link-security.e2e-spec.ts`.
 */
import {
  COMMUNICATION_CATALOG,
  COMMUNICATION_EVENT_KEYS,
} from '../catalog/communication-catalog';
import { withoutCredentials } from './communication-dispatch.service';

describe('outbox credential scrubbing', () => {
  it('every link-token email declares its token a credential', () => {
    for (const key of [
      'auth.email.verification',
      'auth.password.reset',
      'academy.member.invited',
      'academy.learner.invited',
    ] as const) {
      expect(`${key}: ${COMMUNICATION_CATALOG[key].credentialValues?.join(',')}`).toBe(
        `${key}: token`,
      );
    }
  });

  it('every entry whose link carries a token declares it (a new one cannot forget)', () => {
    for (const key of COMMUNICATION_EVENT_KEYS) {
      const entry = COMMUNICATION_CATALOG[key];
      const path = entry.actionUrl?.({
        entity: { type: 'x', id: 'x' },
        values: { token: 'LIVE-TOKEN', academyId: 'a' },
      });
      if (path?.includes('LIVE-TOKEN')) {
        expect(`${key}: ${entry.credentialValues?.includes('token') ?? false}`).toBe(
          `${key}: true`,
        );
      }
    }
  });

  it('only security entries declare credentials (they are never capped or digested)', () => {
    for (const key of COMMUNICATION_EVENT_KEYS) {
      const entry = COMMUNICATION_CATALOG[key];
      if (entry.credentialValues?.length)
        expect(`${key}: ${entry.category}`).toBe(`${key}: security`);
    }
  });

  it('strips exactly the declared keys and keeps the rest', () => {
    expect(
      withoutCredentials(
        { credentialValues: ['token'] },
        { token: 'secret', expiresInHours: 24, academyId: 'a1' },
      ),
    ).toEqual({ expiresInHours: 24, academyId: 'a1' });
  });

  it('leaves the column alone when there is nothing to strip', () => {
    expect(withoutCredentials({}, { token: 'kept' })).toBeUndefined();
    expect(
      withoutCredentials({ credentialValues: ['token'] }, { other: 1 }),
    ).toBeUndefined();
    expect(withoutCredentials({ credentialValues: ['token'] }, null)).toBeUndefined();
    expect(
      withoutCredentials({ credentialValues: ['token'] }, ['token']),
    ).toBeUndefined();
  });
});
