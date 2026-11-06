/**
 * The email scrub runs on every tenant-visible audited string. It must stay
 * linear in the string's length: the old pattern retried from every position
 * of a long run with no `@`, and a course thumbnail saved as a 4 MB data URL
 * froze the API for minutes (UX audit B3).
 */
import { containsEmail, stripEmails } from './audit-sanitize.util';

describe('audit email scrub', () => {
  it('still finds and strips email addresses', () => {
    expect(containsEmail('Invited sara@example.com as instructor')).toBe(true);
    expect(containsEmail('first.last+tag@sub.example.co')).toBe(true);
    expect(stripEmails('Invited sara@example.com as instructor')).toBe(
      'Invited as instructor',
    );
    expect(containsEmail('No address here')).toBe(false);
    expect(containsEmail('price 100@ 5')).toBe(false);
  });

  it('finds an address that sits right after other text', () => {
    expect(containsEmail('owner:sara@example.com')).toBe(true);
    expect(containsEmail('(sara@example.com)')).toBe(true);
  });

  it('scans a long base64 string in linear time', () => {
    const dataUrl = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(50_000);
    const started = Date.now();
    expect(containsEmail(dataUrl)).toBe(false);
    expect(stripEmails(dataUrl)).toBe(dataUrl);
    // ~1.2 MB: the old pattern needed minutes here.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('stays linear after a lone @ followed by a long run', () => {
    const value = 'a@' + 'b'.repeat(500_000);
    const started = Date.now();
    expect(containsEmail(value)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
