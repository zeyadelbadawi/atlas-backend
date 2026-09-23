/**
 * `parseByteRange` — the RFC 7233 single-range logic behind S11 media
 * seeking. The HTTP wiring (206/416/headers) is covered by the media e2e
 * suite; this pins the parser's edge cases, which are the risky part.
 */
import { parseByteRange } from './public-media.controller';

const SIZE = 1000;

describe('parseByteRange', () => {
  it('parses a closed range', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range as running to the last byte', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('clamps an end past the size to the last byte', () => {
    expect(parseByteRange('bytes=900-100000', SIZE)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-200', SIZE)).toEqual({ start: 800, end: 999 });
  });

  it('clamps a suffix larger than the size to the whole thing', () => {
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('reports a start at or past the size as unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-1100', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=2000-', SIZE)).toBe('unsatisfiable');
  });

  it('reports a zero-length suffix as unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  it('ignores an inverted range (start > end)', () => {
    expect(parseByteRange('bytes=500-100', SIZE)).toBeNull();
  });

  it('ignores non-bytes units and multi-range / malformed headers', () => {
    expect(parseByteRange('items=0-10', SIZE)).toBeNull();
    expect(parseByteRange('bytes=0-10,20-30', SIZE)).toBeNull();
    expect(parseByteRange('bytes=', SIZE)).toBeNull();
    expect(parseByteRange('bytes=-', SIZE)).toBeNull();
    expect(parseByteRange('garbage', SIZE)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseByteRange('  bytes=0-99 ', SIZE)).toEqual({ start: 0, end: 99 });
  });
});
