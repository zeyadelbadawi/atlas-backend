import {
  clearSignedInHint,
  setSignedInHint,
  SIGNED_IN_HINT_COOKIE,
} from './signed-in-hint';

describe('signed-in hint cookie', () => {
  const config = { baseDomain: 'atlass.dpdns.org' };
  const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });

  it('is set by the dashboard host over HTTPS, on the base domain, readable, constant value', () => {
    const res = response();
    setSignedInHint(
      { secure: true, hostname: 'dashboard.atlass.dpdns.org' },
      res,
      config,
      60,
    );
    expect(res.cookie).toHaveBeenCalledWith(SIGNED_IN_HINT_COOKIE, '1', {
      domain: 'atlass.dpdns.org',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 60_000,
    });
  });

  it('is set by the apex too (the platform host during the move)', () => {
    const res = response();
    setSignedInHint({ secure: true, hostname: 'atlass.dpdns.org' }, res, config, 60);
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an academy subdomain', { secure: true, hostname: 'nour.atlass.dpdns.org' }],
    ['a custom domain', { secure: true, hostname: 'learn.example.com' }],
    ['plain HTTP', { secure: false, hostname: 'dashboard.atlass.dpdns.org' }],
    [
      'a look-alike host',
      { secure: true, hostname: 'dashboard.atlass.dpdns.org.evil.com' },
    ],
  ])('is never set or cleared by %s', (_label, request) => {
    const res = response();
    setSignedInHint(request, res, config, 60);
    clearSignedInHint(request, res, config);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('is never set without a base domain', () => {
    const res = response();
    setSignedInHint(
      { secure: true, hostname: 'dashboard.atlass.dpdns.org' },
      res,
      {},
      60,
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('is cleared with the same Domain and Path it was set with', () => {
    const res = response();
    clearSignedInHint(
      { secure: true, hostname: 'dashboard.atlass.dpdns.org' },
      res,
      config,
    );
    expect(res.clearCookie).toHaveBeenCalledWith(SIGNED_IN_HINT_COOKIE, {
      domain: 'atlass.dpdns.org',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    });
  });
});
