/**
 * W3-compose — one-click unsubscribe (RFC 2369 / RFC 8058).
 *
 *   GET  /communications/unsubscribe?token=…  — what the link in the email
 *        opens: a small bilingual page with a button. GET never changes
 *        anything, because mail scanners and link previewers fetch links.
 *   POST /communications/unsubscribe?token=…  — the opt-out itself. Mail
 *        clients POST `List-Unsubscribe=One-Click` here directly; the page's
 *        button posts the same form.
 *
 * Public by necessity (the recipient is not signed in), so the token is
 * the whole authorization: an HMAC over (user, category, expiry) that can
 * only turn ONE category's email OFF for ONE person. It is applied through
 * `CommunicationPreferencesService` — the same writer the settings page
 * uses — so the preference page shows the change at once. Throttled per IP.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { IdentityConfig } from '../../../config/configuration';
import { CommunicationPreferencesService } from '../../services/communication-preferences.service';
import { escapeHtmlText } from '../rich-text-sanitizer';
import { unsubscribeKey, verifyUnsubscribeToken } from '../unsubscribe-token';

const COPY = {
  confirmTitle: 'Unsubscribe · إلغاء الاشتراك',
  confirmEn:
    'Stop receiving these messages by email? You will still see them in your notifications.',
  confirmAr: 'هل تريد التوقف عن تلقي هذه الرسائل عبر البريد؟ ستظل تراها في إشعاراتك.',
  button: 'Unsubscribe · إلغاء الاشتراك',
  doneEn:
    'You are unsubscribed. You can turn these emails back on from your profile settings.',
  doneAr: 'تم إلغاء اشتراكك. يمكنك إعادة تفعيل هذه الرسائل من إعدادات ملفك الشخصي.',
  invalidEn:
    'This unsubscribe link is invalid or has expired. Manage your email settings from your profile.',
  invalidAr:
    'رابط إلغاء الاشتراك غير صالح أو منتهي الصلاحية. يمكنك إدارة إعدادات البريد من ملفك الشخصي.',
} as const;

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${COPY.confirmTitle}</title></head><body><main>${body}</main></body></html>`;
}

@Controller('communications/unsubscribe')
export class UnsubscribeController {
  private readonly key: Buffer | null;

  constructor(
    private readonly preferences: CommunicationPreferencesService,
    configService: ConfigService,
  ) {
    const secret = configService.get<IdentityConfig>('identity')?.jwtAccessSecret;
    this.key = secret ? unsubscribeKey(secret) : null;
  }

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  confirm(@Query('token') token: string | undefined): string {
    const payload = this.key && token ? verifyUnsubscribeToken(this.key, token) : null;
    if (!payload) {
      return page(`<p>${COPY.invalidEn}</p><p dir="rtl" lang="ar">${COPY.invalidAr}</p>`);
    }
    const action = `?token=${encodeURIComponent(token!)}`;
    return page(
      `<p>${COPY.confirmEn}</p><p dir="rtl" lang="ar">${COPY.confirmAr}</p>` +
        `<form method="post" action="${escapeHtmlText(action)}"><button type="submit">${COPY.button}</button></form>`,
    );
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async unsubscribe(
    @Query('token') token: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const payload = this.key && token ? verifyUnsubscribeToken(this.key, token) : null;
    if (!payload) {
      throw new BadRequestException({
        messageKey: 'errors.messaging.unsubscribeInvalid',
        code: 'UNSUBSCRIBE_TOKEN_INVALID',
      });
    }
    await this.preferences.update(
      payload.userId,
      payload.category === 'engagement'
        ? { engagement: { email: false } }
        : { operational: { email: false } },
    );
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    response.setHeader('Cache-Control', 'no-store');
    if (wantsHtml) {
      response
        .status(HttpStatus.OK)
        .type('text/html; charset=utf-8')
        .send(page(`<p>${COPY.doneEn}</p><p dir="rtl" lang="ar">${COPY.doneAr}</p>`));
      return;
    }
    response
      .status(HttpStatus.OK)
      .json({ unsubscribed: true, category: payload.category });
  }
}
