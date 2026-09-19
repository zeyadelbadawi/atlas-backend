/**
 * The duration parser is a BILLING input: `videoStorageMinutes` is
 * denominated in minutes, so whatever this returns is what a tenant's
 * quota is charged. These tests therefore care about two things above
 * all — that a real file is measured correctly, and that a file it cannot
 * understand yields `null` rather than a plausible-looking wrong number.
 */
import { parseMp4Duration } from './video-duration.util';

/** Builds a minimal ISO-BMFF box. */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt8(0, 0); // version 0
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box('mvhd', payload);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const payload = Buffer.alloc(112);
  payload.writeUInt8(1, 0); // version 1
  payload.writeUInt32BE(timescale, 20);
  payload.writeBigUInt64BE(duration, 24);
  return box('mvhd', payload);
}

/** A faststart-shaped file: `ftyp`, then `moov` before the media data. */
function faststart(mvhd: Buffer): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    box('moov', mvhd),
    box('mdat', Buffer.alloc(64)),
  ]);
}

describe('parseMp4Duration', () => {
  it('reads a version 0 mvhd', () => {
    // 600 ticks per second, 360,000 ticks → 600 seconds.
    expect(parseMp4Duration(faststart(mvhdV0(600, 360_000)))).toEqual({
      durationSeconds: 600,
    });
  });

  it('reads a version 1 mvhd, whose duration is 64-bit', () => {
    expect(parseMp4Duration(faststart(mvhdV1(90_000, 81_000_000n)))).toEqual({
      durationSeconds: 900,
    });
  });

  it('rounds to the nearest second rather than truncating', () => {
    // 1000 ticks/s, 90,600 ticks = 90.6 s. A quota charged in whole
    // minutes should see 91, not 90 — and certainly not 0.
    expect(parseMp4Duration(faststart(mvhdV0(1000, 90_600)))?.durationSeconds).toBe(91);
  });

  it('skips boxes it does not understand to find moov', () => {
    const file = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('free', Buffer.alloc(32)),
      box('wide', Buffer.alloc(16)),
      box('moov', mvhdV0(600, 6000)),
    ]);
    expect(parseMp4Duration(file)?.durationSeconds).toBe(10);
  });

  it('returns null when moov is not in the head — the non-faststart case', () => {
    // The real failure mode this parser has: `moov` at the END of the
    // file, which a ranged read of the head never sees. Null is the
    // honest answer, and the caller records the provenance as `declared`
    // rather than pretending it measured something.
    const file = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('mdat', Buffer.alloc(256)),
    ]);
    expect(parseMp4Duration(file)).toBeNull();
  });

  it('returns null for bytes that are not an MP4 at all', () => {
    expect(parseMp4Duration(Buffer.from('this is not a video', 'utf8'))).toBeNull();
    expect(parseMp4Duration(Buffer.alloc(0))).toBeNull();
  });

  it('returns null rather than a nonsense duration', () => {
    // A zero timescale would divide by zero; a zero duration is not a
    // video. Both must yield null, because feeding either into a minutes
    // quota is worse than admitting the duration is unknown.
    expect(parseMp4Duration(faststart(mvhdV0(0, 1000)))).toBeNull();
    expect(parseMp4Duration(faststart(mvhdV0(600, 0)))).toBeNull();
  });

  it('rejects an implausibly long duration instead of believing it', () => {
    // 48 hours. Outside the sanity bound, so the bytes were not what we
    // thought — reporting it would charge a tenant for two days of video.
    expect(parseMp4Duration(faststart(mvhdV0(1, 48 * 60 * 60)))).toBeNull();
  });

  it('does not hang or read past the buffer on a truncated box', () => {
    const truncated = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      // Declares 4 KB but only 16 bytes follow — exactly what a ranged
      // read of a large file looks like.
      (() => {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(4096, 0);
        header.write('mdat', 4, 'latin1');
        return Buffer.concat([header, Buffer.alloc(16)]);
      })(),
    ]);
    expect(() => parseMp4Duration(truncated)).not.toThrow();
    expect(parseMp4Duration(truncated)).toBeNull();
  });

  it('handles a 64-bit box size without looping forever', () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0); // size === 1 → 64-bit size follows
    header.write('free', 4, 'latin1');
    header.writeBigUInt64BE(16n, 8);
    const file = Buffer.concat([header, box('moov', mvhdV0(600, 1200))]);
    expect(parseMp4Duration(file)?.durationSeconds).toBe(2);
  });
});
