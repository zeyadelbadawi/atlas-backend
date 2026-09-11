/**
 * The one deterministic answer to "you saved a version that is no longer
 * the current one".
 *
 * WHY A DEDICATED EXCEPTION. A conflict has to be machine-distinguishable
 * from every other 409 the API can return (a duplicate slug, an
 * already-cancelled subscription), because the frontend reaction is
 * completely different: a duplicate slug means fix the field, a stale
 * version means someone else's work is on the server and you are about to
 * lose yours. `code` is what the client switches on; `messageKey` is what
 * it renders. Both are part of the contract, not debugging text.
 *
 * WHAT IT CARRIES, AND WHY EACH PIECE. `currentVersion` lets the client
 * re-issue the save against the right token after the user has looked at
 * what changed — this is the mechanism that makes "take over" safe rather
 * than a euphemism for overwriting. `lastEditedByName` is what turns "this
 * changed" into "Ahmed changed this", which is the difference between a
 * dead end and a conversation; it is absent rather than invented when the
 * row has no recorded editor.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: the server's copy of the content.
 * Returning it would tempt a client into silently merging, and the whole
 * point of this exception is that the person decides. The client re-reads
 * through the normal authorised endpoint, under the normal authorisation.
 */
import { ConflictException } from '@nestjs/common';

export const STALE_RESOURCE_VERSION_CODE = 'stale_resource_version';

export interface StaleResourceVersionDetails {
  /** The version the caller believed it was updating. */
  readonly submittedVersion: number;
  /** The version actually stored now — what a retry must be based on. */
  readonly currentVersion: number;
  /** Display name of whoever saved the current version, when recorded. */
  readonly lastEditedByName?: string;
  /** When the current version was saved, when recorded. */
  readonly lastEditedAt?: string;
}

export class StaleResourceVersionException extends ConflictException {
  constructor(details: StaleResourceVersionDetails) {
    super({
      code: STALE_RESOURCE_VERSION_CODE,
      messageKey: 'errors.concurrency.staleVersion',
      // Under `details` rather than spread at the top level: the exception
      // filter forwards that field by name and drops everything else, which
      // is what keeps an error response a contract instead of a window into
      // whatever an exception was carrying.
      details: {
        submittedVersion: details.submittedVersion,
        currentVersion: details.currentVersion,
        ...(details.lastEditedByName
          ? { lastEditedByName: details.lastEditedByName }
          : {}),
        ...(details.lastEditedAt ? { lastEditedAt: details.lastEditedAt } : {}),
      },
    });
  }
}
