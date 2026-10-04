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
import { TemplateRegistry } from '../templates/template-registry';

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

  it('W3: every emailed one-time code is declared a credential, so the outbox drops it on settle', () => {
    for (const key of ['auth.email.otp', 'auth.account.deletion_code'] as const) {
      expect(`${key}: ${COMMUNICATION_CATALOG[key].credentialValues?.join(',')}`).toBe(
        `${key}: code`,
      );
    }
  });

  it('W3: no catalogue entry carries a `code` value without declaring it (a new one cannot forget)', () => {
    // Every key whose template prints `values.code` must scrub it.
    for (const key of COMMUNICATION_EVENT_KEYS) {
      const entry = COMMUNICATION_CATALOG[key];
      let printsCode = false;
      for (const locale of ['en', 'ar'] as const) {
        const rendered = TemplateRegistry.render(
          entry.template,
          locale,
          {
            branding: { platformName: 'Atlas', platformUrl: 'https://app.atlas.test/' },
            actionUrl: null,
            settingsUrl: 'https://app.atlas.test/dashboard/profile',
          },
          { code: '918273' },
        );
        if (`${rendered.text}${rendered.html}`.includes('918273')) printsCode = true;
      }
      if (printsCode) {
        expect(`${key}: ${entry.credentialValues?.includes('code') ?? false}`).toBe(
          `${key}: true`,
        );
      }
    }
  });

  it('W3: the code never appears in a subject line, in either locale', () => {
    for (const key of ['auth.email.otp', 'auth.account.deletion_code'] as const) {
      for (const locale of ['en', 'ar'] as const) {
        const rendered = TemplateRegistry.render(
          COMMUNICATION_CATALOG[key].template,
          locale,
          {
            branding: {
              academyName: 'Horizon',
              platformName: 'Atlas',
              platformUrl: 'https://app.atlas.test/',
            },
            actionUrl: null,
            settingsUrl: 'https://app.atlas.test/dashboard/profile',
          },
          { code: '048915', expiresInMinutes: 10 },
        );
        expect(`${key}/${locale}: ${rendered.subject.includes('048915')}`).toBe(
          `${key}/${locale}: false`,
        );
        expect(rendered.subject).not.toMatch(/\d{6}/);
        // ...and it is still in the body, where it belongs.
        expect(rendered.text).toContain('048915');
        expect(rendered.html).toContain('048915');
      }
    }
  });

  it('W3: a settled OTP row keeps everything except the code', () => {
    expect(
      withoutCredentials(COMMUNICATION_CATALOG['auth.email.otp'], {
        code: '123456',
        expiresInMinutes: 10,
      }),
    ).toEqual({ expiresInMinutes: 10 });
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
