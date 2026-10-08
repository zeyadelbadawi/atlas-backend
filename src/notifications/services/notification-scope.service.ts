/**
 * Notification context isolation — the ONE place that decides which feed a
 * request may read or change.
 *
 * One Atlas identity can be a Management user and a learner at several
 * academies at once. The context comes from the SESSION's own server-side
 * record (`AuthContext.surface` / `academyId`, resolved from the session
 * row by `JwtAuthGuard`), never from a query parameter, a body, a route
 * segment or a header the client chose:
 *  - a session minted on the Management surface reads Management
 *    notifications (and the account's own security notices);
 *  - a session minted on Academy A's website reads Academy A's — and only
 *    when the request really arrives on A's host (a token minted on A and
 *    presented to B's host is refused, exactly like the learning routes);
 *  - anything else reads nothing.
 */
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AcademySurfaceService } from '../../identity/services/academy-surface.service';
import { assertSessionServesHostAcademy } from '../../learning/dto/learning-request.util';
import type { NotificationScope } from '../../notification-events/repositories/notifications.repository';

@Injectable()
export class NotificationScopeService {
  constructor(private readonly academySurfaceService: AcademySurfaceService) {}

  async resolve(request: Request): Promise<NotificationScope> {
    const auth = request.authContext;
    if (!auth) return { kind: 'none' };
    if (auth.surface === 'management') return { kind: 'management' };
    if (auth.surface === 'academy' && auth.academyId) {
      const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
        request.hostname,
      );
      assertSessionServesHostAcademy(request, hostAcademyId);
      return { kind: 'academy', academyId: auth.academyId };
    }
    return { kind: 'none' };
  }
}
