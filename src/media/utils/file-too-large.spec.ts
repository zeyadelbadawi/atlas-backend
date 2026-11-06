import { PayloadTooLargeException } from '@nestjs/common';
import { assertWithinSizeLimit } from './file-validation.util';

describe('file over the size limit', () => {
  it('says the limit, so the dashboard can show it', () => {
    let thrown: unknown;
    try {
      assertWithinSizeLimit(Buffer.alloc(11), 10);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PayloadTooLargeException);
    expect((thrown as PayloadTooLargeException).getResponse()).toEqual({
      messageKey: 'errors.media.fileTooLarge',
      details: { maxBytes: 10 },
    });
  });

  it('accepts a file at the limit', () => {
    expect(() => assertWithinSizeLimit(Buffer.alloc(10), 10)).not.toThrow();
  });
});
