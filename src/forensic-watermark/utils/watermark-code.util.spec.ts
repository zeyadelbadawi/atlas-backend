import {
  CROCKFORD_ALPHABET,
  crockfordCheckSymbol,
  crockfordCheckValue,
  formatWatermarkCode,
  generateWatermarkCode,
  normalizeWatermarkCode,
} from './watermark-code.util';

describe('forensic watermark codes', () => {
  it('draws ten Crockford symbols whose last is a valid mod-37 check', () => {
    for (let i = 0; i < 2000; i += 1) {
      const code = generateWatermarkCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
      expect(crockfordCheckSymbol(code.slice(0, 9))).toBe(code[9]);
    }
  });

  it('never issues a code whose check would need one of * ~ $ = U', () => {
    // Any data string whose check value is 32..36 must be rejected.
    let rejected = '';
    for (let n = 0; !rejected; n += 1) {
      const data = [...n.toString(32).padStart(9, '0')]
        .map((digit) => CROCKFORD_ALPHABET[parseInt(digit, 32)])
        .join('');
      if (crockfordCheckValue(data) >= 32) rejected = data;
    }
    const script = [...rejected, ...'7K3QMX9TR'].map((symbol) =>
      CROCKFORD_ALPHABET.indexOf(symbol),
    );
    const code = generateWatermarkCode(() => script.shift() as number);
    expect(code.slice(0, 9)).toBe('7K3QMX9TR');
    expect(script).toHaveLength(0);
  });

  it('formats as two groups of five', () => {
    expect(formatWatermarkCode('7K3QMX9TR7')).toBe('7K3QM-X9TR7');
  });

  it('normalises OCR-style input: case, separators, O/I/L aliases, Arabic digits', () => {
    const code = generateWatermarkCode();
    const display = formatWatermarkCode(code);
    const messy = ` ${display.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')} `
      .split('')
      .join(' ');
    expect(normalizeWatermarkCode(messy)).toEqual({ ok: true, code, display });
    expect(normalizeWatermarkCode(display.replace('-', '.'))).toMatchObject({
      ok: true,
      code,
    });
    const arabic = code.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
    expect(normalizeWatermarkCode(arabic)).toMatchObject({ ok: true, code });
  });

  it('reports a misread symbol as a checksum problem, not a miss', () => {
    const code = generateWatermarkCode();
    const swapped = code.slice(0, 3) + (code[3] === 'A' ? 'B' : 'A') + code.slice(4);
    expect(normalizeWatermarkCode(swapped)).toMatchObject({
      ok: false,
      problem: 'checksum',
    });
  });

  it('reports empty, length and symbol problems', () => {
    expect(normalizeWatermarkCode('')).toMatchObject({ ok: false, problem: 'empty' });
    expect(normalizeWatermarkCode('ABC')).toMatchObject({ ok: false, problem: 'length' });
    expect(normalizeWatermarkCode('ABCDEFGHU0')).toMatchObject({
      ok: false,
      problem: 'symbol',
    });
  });
});
