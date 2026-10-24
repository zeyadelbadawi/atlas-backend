/** A push message for ONE device token. Every `data` value is a string (FCM rule). */
export interface PushMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string>>;
  /** Unread count for the app icon badge (iOS). */
  readonly badge?: number;
}

export type PushSendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  /** The token is dead (app uninstalled, token rotated): stop using it. */
  | { readonly ok: false; readonly reason: 'invalid_token' }
  /** Worth retrying later (network, 5xx, quota). */
  | { readonly ok: false; readonly reason: 'transient'; readonly detail: string }
  /** Our side is wrong (credentials, payload); retrying will not help. */
  | { readonly ok: false; readonly reason: 'rejected'; readonly detail: string };

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<PushSendResult>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
