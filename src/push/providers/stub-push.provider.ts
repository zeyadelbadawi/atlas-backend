import { Logger } from '@nestjs/common';
import type { PushMessage, PushProvider, PushSendResult } from './push-provider';

/**
 * Used whenever FCM is not configured (local, CI, e2e). Sends nothing and
 * keeps the last messages in memory so tests can assert on them. Tokens
 * starting `invalid-` answer as dead tokens, for the cleanup path.
 */
export class StubPushProvider implements PushProvider {
  readonly name = 'stub';
  private readonly logger = new Logger(StubPushProvider.name);
  readonly sent: PushMessage[] = [];

  async send(message: PushMessage): Promise<PushSendResult> {
    if (message.token.startsWith('invalid-')) {
      return { ok: false, reason: 'invalid_token' };
    }
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();
    this.logger.debug({ title: message.title }, 'Stub push provider: push would be sent');
    return { ok: true, providerMessageId: `stub-${this.sent.length}` };
  }
}
