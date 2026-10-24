/**
 * Firebase Cloud Messaging, HTTP v1 API — Android directly, iOS through the
 * APNs key uploaded to the Firebase project.
 *
 * Authenticates as a service account with a self-signed RS256 JWT exchanged
 * for an OAuth access token (cached until shortly before it expires), using
 * only Node's own `crypto` and `fetch` — no new dependency.
 */
import { createSign } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { PushMessage, PushProvider, PushSendResult } from './push-provider';

export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  /** PEM; `\n` escapes are accepted (how it arrives from an env file). */
  readonly privateKey: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

const b64url = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64url');

export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly privateKey: string;
  private accessToken: { readonly value: string; readonly expiresAt: number } | null =
    null;

  constructor(
    private readonly credentials: FcmCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.privateKey = credentials.privateKey.replace(/\\n/g, '\n');
  }

  async send(message: PushMessage): Promise<PushSendResult> {
    let token: string;
    try {
      token = await this.token();
    } catch (error) {
      return { ok: false, reason: 'transient', detail: this.describe(error) };
    }
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
      this.credentials.projectId,
    )}/messages:send`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: this.payload(message) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, reason: 'transient', detail: this.describe(error) };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { name?: string };
      return { ok: true, providerMessageId: body.name ?? '' };
    }
    const text = await response.text().catch(() => '');
    if (response.status === 401) this.accessToken = null;
    // Only FCM's own verdict on the TOKEN removes a device. A bare 404 (a
    // wrong FCM_PROJECT_ID, say) is our misconfiguration and would otherwise
    // delete every registered device.
    if (
      /UNREGISTERED|registration-token-not-registered/.test(text) ||
      (response.status === 400 &&
        /registration token|INVALID_ARGUMENT.*token/i.test(text))
    ) {
      return { ok: false, reason: 'invalid_token' };
    }
    const detail = `${response.status} ${text.slice(0, 200)}`;
    return response.status === 429 || response.status >= 500
      ? { ok: false, reason: 'transient', detail }
      : { ok: false, reason: 'rejected', detail };
  }

  private payload(message: PushMessage): Record<string, unknown> {
    return {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: 'high',
        notification: { channel_id: 'atlas_default', sound: 'default' },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            ...(message.badge !== undefined ? { badge: message.badge } : {}),
          },
        },
      },
    };
  }

  private async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && this.accessToken.expiresAt - 60 > now) {
      return this.accessToken.value;
    }
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: this.credentials.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(this.privateKey))}`;
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`FCM token exchange failed: ${response.status}`);
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: now + body.expires_in };
    return body.access_token;
  }

  private describe(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    this.logger.warn({ error: text }, 'FCM request failed');
    return text.slice(0, 200);
  }
}
