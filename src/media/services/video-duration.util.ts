/**
 * Establishing a video's real duration without trusting the uploader
 * (master plan D5, Phase 2 §D.5).
 *
 * WHY THIS EXISTS. `videoStorageMinutes` is a plan entitlement denominated
 * in minutes, so a video's duration is a billing-relevant number. Cloudflare
 * Stream measures it and reports it on a webhook. The Normal tier has no
 * such provider — the bytes are an object in Atlas's own bucket — so if
 * Atlas simply believed whatever the uploader declared, the quota would be
 * self-reported and therefore meaningless: a tenant could upload a
 * three-hour lecture, declare it as one minute, and consume one minute of
 * their allowance.
 *
 * THE APPROACH. An MP4's `mvhd` box carries `duration` and `timescale`,
 * and duration in seconds is simply `duration / timescale`. The box lives
 * inside `moov`, which for a web-optimised ("faststart") file sits at the
 * front — so a ranged read of the first few hundred kilobytes is usually
 * enough, and costs no transcoding and no `ffmpeg`.
 *
 * WHEN IT FAILS. A file that was not written faststart keeps `moov` at the
 * END, and this parser will not find it in the head. That is not a bug to
 * hide: the caller records `declared` as the provenance and the operator
 * can see, through the duration-provenance metric, how often the quota is
 * resting on the uploader's word rather than a measurement. A worker-side
 * `ffprobe` is the documented next step for those files.
 *
 * Pure and synchronous so the parsing is unit-testable without a network,
 * a bucket or a fixture server.
 */

/** Both 32-bit (version 0) and 64-bit (version 1) `mvhd` layouts are handled. */
export interface ParsedDuration {
  readonly durationSeconds: number;
}

/**
 * Walks the ISO-BMFF box tree looking for `moov` → `mvhd`.
 *
 * Deliberately iterative rather than a full parser: it reads box headers,
 * descends into `moov`, and stops at the first `mvhd`. Anything it does
 * not understand it skips by the box's own declared size, so a file with
 * unexpected boxes is handled rather than rejected.
 */
export function parseMp4Duration(head: Buffer): ParsedDuration | null {
  const mvhd = findBox(head, 0, head.length, ['moov', 'mvhd']);
  if (!mvhd) return null;

  // `mvhd` payload: version(1) flags(3) then, for version 0,
  // creation(4) modification(4) timescale(4) duration(4);
  // for version 1, creation(8) modification(8) timescale(4) duration(8).
  const { start, end } = mvhd;
  if (end - start < 20) return null;
  const version = head.readUInt8(start);

  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (end - start < 32) return null;
    timescale = head.readUInt32BE(start + 20);
    // `readBigUInt64BE` → Number is safe here: a duration that overflowed
    // 2^53 ticks would be geological, and a wrong huge number is caught by
    // the sanity bound below rather than silently believed.
    duration = Number(head.readBigUInt64BE(start + 24));
  } else {
    timescale = head.readUInt32BE(start + 12);
    duration = head.readUInt32BE(start + 16);
  }

  if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
  const seconds = Math.round(duration / timescale);
  // A sanity bound, not a product limit: anything outside it means the
  // bytes were not what we thought, and reporting a nonsense duration into
  // a billing quota is worse than reporting none.
  if (seconds <= 0 || seconds > 24 * 60 * 60) return null;
  return { durationSeconds: seconds };
}

/** Finds a nested box by type path, returning the payload bounds of the last element. */
function findBox(
  buffer: Buffer,
  from: number,
  to: number,
  path: readonly string[],
): { start: number; end: number } | null {
  let offset = from;
  while (offset + 8 <= to) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);

    // `size === 1` means a 64-bit size follows the type; `size === 0`
    // means "to the end of the file". Both are legal and both would make
    // a naive walker loop forever, so they are handled explicitly.
    let headerSize = 8;
    let boxSize = size;
    if (size === 1) {
      if (offset + 16 > to) return null;
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      boxSize = to - offset;
    }
    if (boxSize < headerSize || offset + boxSize > to) {
      // Truncated — which is the normal case when only the head of the
      // file was fetched. Descend if this is the box we want, otherwise
      // give up rather than read past the buffer.
      if (type !== path[0]) return null;
      boxSize = to - offset;
    }

    if (type === path[0]) {
      const payloadStart = offset + headerSize;
      const payloadEnd = offset + boxSize;
      if (path.length === 1) return { start: payloadStart, end: payloadEnd };
      return findBox(buffer, payloadStart, payloadEnd, path.slice(1));
    }
    offset += boxSize;
  }
  return null;
}
