import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { classValidatorErrorsToViolations } from '../../common/validation/class-validator-violations.util';
import { UpdateAtlasCommissionConfigDto } from './update-atlas-commission-config.dto';
import { UpdateOrganizationCommissionDto } from './update-organization-commission.dto';
import { UpdatePlanCommissionDto } from './update-plan-commission.dto';
import {
  CreatePlatformBankTransferMethodDto,
  CreatePlatformInstapayMethodDto,
  CreatePlatformWalletMethodDto,
} from './platform-payment-method.dto';

function violationsFor<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
) {
  return classValidatorErrorsToViolations(validateSync(plainToInstance(cls, plain)));
}

const PERCENT_RANGE = {
  messageKey: 'errors.commission.percentageRange',
  values: { min: 0, max: 100 },
};

/** B8 (UX audit) V29 — commission ranges speak in percent although the wire carries basis points. */
describe('Commission DTOs — range in percent', () => {
  it.each([-500, 10001, 1234.5, 'abc'])('refuses %p basis points', (value) => {
    expect(
      violationsFor(UpdateOrganizationCommissionDto, {
        commissionMode: 'custom',
        customPercentageBasisPoints: value,
      }),
    ).toEqual([{ field: 'customPercentageBasisPoints', ...PERCENT_RANGE }]);
    expect(
      violationsFor(UpdatePlanCommissionDto, { commissionBasisPoints: value }),
    ).toEqual([{ field: 'commissionBasisPoints', ...PERCENT_RANGE }]);
    expect(
      violationsFor(UpdateAtlasCommissionConfigDto, {
        defaultCommissionBasisPoints: value,
      }),
    ).toEqual([{ field: 'defaultCommissionBasisPoints', ...PERCENT_RANGE }]);
  });

  it.each([0, 1250, 10000])('accepts %p basis points', (value) => {
    expect(
      violationsFor(UpdateOrganizationCommissionDto, {
        commissionMode: 'custom',
        customPercentageBasisPoints: value,
      }),
    ).toEqual([]);
  });

  it('ignores the percentage outside custom mode', () => {
    expect(
      violationsFor(UpdateOrganizationCommissionDto, {
        commissionMode: 'exempt',
        customPercentageBasisPoints: -500,
      }),
    ).toEqual([]);
  });
});

/** B8 (UX audit) V15 — a wrong format names the key that shows the expected format. */
describe('Manual payment method DTOs — format keys', () => {
  const TEXTS = {
    accountName: 'Atlas',
    instructions: 'Send the exact amount.',
    referenceInstructions: 'Write the checkout id.',
  };

  it('bank transfer: account number, IBAN and SWIFT', () => {
    expect(
      violationsFor(CreatePlatformBankTransferMethodDto, {
        displayName: 'Bank',
        instructions: {
          bankName: 'Atlas Bank',
          accountNumber: '12#34',
          iban: 'EG12',
          swiftCode: 'NBE',
          ...TEXTS,
        },
      }),
    ).toEqual([
      {
        field: 'instructions.accountNumber',
        messageKey: 'validation:invalidAccountNumber',
      },
      { field: 'instructions.iban', messageKey: 'validation:invalidIban' },
      { field: 'instructions.swiftCode', messageKey: 'validation:invalidSwift' },
    ]);
  });

  it('wallet number and InstaPay address', () => {
    expect(
      violationsFor(CreatePlatformWalletMethodDto, {
        displayName: 'Wallet',
        instructions: { walletProvider: 'vodafone_cash', walletNumber: '0123', ...TEXTS },
      }),
    ).toEqual([
      {
        field: 'instructions.walletNumber',
        messageKey: 'validation:invalidWalletNumber',
      },
    ]);
    expect(
      violationsFor(CreatePlatformInstapayMethodDto, {
        displayName: 'InstaPay',
        instructions: { instapayAddress: 'ziad', ...TEXTS },
      }),
    ).toEqual([
      {
        field: 'instructions.instapayAddress',
        messageKey: 'validation:invalidInstapayAddress',
      },
    ]);
  });
});
