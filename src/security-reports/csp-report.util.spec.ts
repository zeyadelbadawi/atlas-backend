import { MAX_REPORTS_PER_REQUEST, parseCspReports } from './csp-report.util';

describe('parseCspReports', () => {
  it('normalises a legacy report-uri body and keeps no query, fragment or token', () => {
    const [v] = parseCspReports({
      'csp-report': {
        'document-uri': 'https://atlass.dpdns.org/auth/reset-password?token=SECRET#x',
        'violated-directive': "script-src-elem 'self'",
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'https://evil.example/x.js?sig=SECRET',
        'source-file': 'https://atlass.dpdns.org/assets/index.js',
        'line-number': 12,
        disposition: 'report',
      },
    });
    expect(v).toEqual({
      directive: 'script-src-elem',
      blockedKind: 'external',
      blockedOrigin: 'https://evil.example',
      documentPath: 'atlass.dpdns.org/auth/reset-password',
      disposition: 'report',
      sourceOrigin: 'https://atlass.dpdns.org',
      line: 12,
    });
    expect(JSON.stringify(v)).not.toContain('SECRET');
  });

  it('normalises a Reporting API batch and classifies inline/eval/data/blob/self', () => {
    const entry = (blockedURL: string, effectiveDirective = 'style-src-elem') => ({
      type: 'csp-violation',
      url: 'https://a.atlass.dpdns.org/courses',
      body: {
        documentURL: 'https://a.atlass.dpdns.org/courses',
        blockedURL,
        effectiveDirective,
      },
    });
    const kinds = parseCspReports([
      entry('inline'),
      entry('eval', 'script-src'),
      entry('data:image/png;base64,AAA', 'img-src'),
      entry('blob:https://a.atlass.dpdns.org/1', 'worker-src'),
      entry('https://a.atlass.dpdns.org/x.css'),
      { type: 'deprecation', body: {} },
    ]).map((v) => v.blockedKind);
    expect(kinds).toEqual(['inline', 'eval', 'data', 'blob', 'self']);
  });

  it('drops anything unrecognisable and bounds a batch', () => {
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports('x')).toEqual([]);
    expect(parseCspReports({ 'csp-report': 'x' })).toEqual([]);
    const many = Array.from({ length: 500 }, () => ({
      type: 'csp-violation',
      body: { effectiveDirective: 'img-src', blockedURL: 'https://cdn.example/a.png' },
    }));
    expect(parseCspReports(many)).toHaveLength(MAX_REPORTS_PER_REQUEST);
  });

  it('never lets a hostile directive or line through as-is', () => {
    const [v] = parseCspReports({
      'csp-report': {
        'violated-directive': '<script>alert(1)</script>',
        'blocked-uri': 'javascript:alert(1)',
        'line-number': 'NaN',
      },
    });
    expect(v).toMatchObject({ directive: 'unknown', blockedKind: 'other', line: null });
  });
});
