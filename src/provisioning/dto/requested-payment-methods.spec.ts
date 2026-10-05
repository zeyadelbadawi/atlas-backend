import { BadRequestException } from '@nestjs/common';
import {
  parseRequestedPaymentMethods,
  readRequestedPaymentMethods,
} from './requested-payment-methods';

const TEXTS = {
  accountName: ' Nile Academy ',
  instructions: 'Transfer the price.',
  referenceInstructions: 'Use your email as the reference.',
};

describe('requested payment methods (setup form)', () => {
  it('is null when no method was chosen ("set up later")', () => {
    expect(parseRequestedPaymentMethods(undefined)).toBeNull();
    expect(parseRequestedPaymentMethods({})).toBeNull();
  });

  it('normalises each chosen method by the shared rules', () => {
    const stored = parseRequestedPaymentMethods({
      bankTransfer: {
        ...TEXTS,
        bankName: 'CIB',
        accountNumber: '100-200',
        iban: 'eg38 0019 0005 0000 0000 2631 8000 2',
      },
      instapay: { ...TEXTS, instapayAddress: 'Nile.Academy@InstaPay' },
      wallet: { ...TEXTS, walletProvider: 'we_pay', walletNumber: '+20 15 1234 5678' },
    });
    expect(stored).toEqual({
      manual_bank_transfer: expect.objectContaining({
        type: 'manual_bank_transfer',
        accountName: 'Nile Academy',
        iban: 'EG380019000500000000263180002',
      }),
      manual_instapay: expect.objectContaining({
        type: 'manual_instapay',
        instapayAddress: 'nile.academy@instapay',
      }),
      manual_wallet_transfer: expect.objectContaining({
        type: 'manual_wallet_transfer',
        walletNumber: '01512345678',
      }),
    });
  });

  it('refuses whitespace-only details', () => {
    expect(() =>
      parseRequestedPaymentMethods({
        instapay: { ...TEXTS, accountName: '   ', instapayAddress: 'a.b@instapay' },
      }),
    ).toThrow(BadRequestException);
  });

  it('reads back only well-formed entries of the three manual types', () => {
    expect(
      readRequestedPaymentMethods({
        manual_instapay: { type: 'manual_instapay', instapayAddress: 'x@instapay' },
        manual_bank_transfer: { type: 'manual_wallet_transfer' },
        gateway: { type: 'gateway' },
        manual_wallet_transfer: 'nope',
      }),
    ).toEqual({
      manual_instapay: { type: 'manual_instapay', instapayAddress: 'x@instapay' },
    });
    expect(readRequestedPaymentMethods(null)).toEqual({});
    expect(readRequestedPaymentMethods([1, 2])).toEqual({});
  });
});
