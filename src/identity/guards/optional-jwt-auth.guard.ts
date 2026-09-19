/**
 * `OptionalJwtAuthGuard` — P64 Phase 2.
 *
 * Exists for exactly one endpoint shape: a route that MUST work for an
 * anonymous visitor and must ALSO know who the caller is when they happen
 * to be signed in. The content grant is that shape, because a PREVIEW
 * lesson is meant to open for a prospective student who has no account
 * yet (Phase 2 §V), while the same URL for a non-preview lesson has to
 * identify the learner to check their enrollment, device and lease.
 *
 * WHY NOT JUST OMIT THE GUARD. Without one, a signed-in learner's token
 * would be ignored and every request would look anonymous — so a real
 * learner would be refused their own non-preview lesson while holding a
 * perfectly good session. The alternative, two endpoints, would mean the
 * frontend had to know whether a lesson was a preview before it was
 * allowed to ask, which is exactly the information the curriculum
 * deliberately no longer volunteers.
 *
 * IT NEVER GRANTS ANYTHING. It admits the request either way; all it does
 * is populate `authContext` when — and only when — a token verifies
 * completely. A bad, expired, forged or revoked token is treated as NO
 * token, never as a valid one: the caller is then anonymous and gets
 * exactly what an anonymous caller gets, which for anything but a preview
 * is a 404. Delegating to `JwtAuthGuard` rather than re-implementing
 * verification is the point — signature checking, expiry and the
 * revocation lookup have one implementation, and this cannot drift into a
 * weaker one.
 */
import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtAuthGuard: JwtAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await this.jwtAuthGuard.canActivate(context);
    } catch {
      // Anonymous. `authContext` stays unset, which is the signal every
      // downstream service already reads as "no identity".
    }
    return true;
  }
}
