import type { Prisma } from '@prisma/client';
import {
  PaymentsRepository,
  paymentSearchTerms,
  subscriptionPaymentSearchTerms,
} from './payments.repository';
import type { PrismaService } from '../../database/prisma.service';

/**
 * B8 (UX audit) V02 — the Platform review list's search finds a payment by
 * every reference a reviewer holds: the checkout id the customer was told
 * to write on the transfer, the payer reference on a proof, and the paying
 * organization's name, besides the payment's own id and references.
 */
describe('Platform payment review search', () => {
  const insensitive = (value: string) => ({ contains: value, mode: 'insensitive' });

  it('every list matches the proofs’ payer reference', () => {
    expect(paymentSearchTerms('NBE-1234')).toContainEqual({
      proofs: { some: { payerReference: insensitive('NBE-1234') } },
    });
  });

  it('the subscription list also matches the checkout id (any part, any case) and the organization name', () => {
    const terms = subscriptionPaymentSearchTerms('3F2A9C');
    expect(terms).toEqual(
      expect.arrayContaining([
        { id: '3F2A9C' },
        { providerReference: insensitive('3F2A9C') },
        { checkoutId: insensitive('3F2A9C') },
        { organization: { is: { name: insensitive('3F2A9C') } } },
        { proofs: { some: { payerReference: insensitive('3F2A9C') } } },
      ]),
    );
  });

  it('findManyAnyOrganization trims the term and ORs every subscription term', async () => {
    let where: Prisma.PaymentWhereInput | undefined;
    const tx = {
      payment: {
        findMany: jest.fn(async (args: { where: Prisma.PaymentWhereInput }) => {
          where = args.where;
          return [];
        }),
        count: jest.fn(async () => 0),
      },
    } as unknown as Prisma.TransactionClient;
    const repository = new PaymentsRepository({} as PrismaService);

    await repository.findManyAnyOrganization(tx, {
      search: '  Acme  ',
      skip: 0,
      take: 20,
    });

    expect(where).toMatchObject({
      checkoutId: { not: null },
      OR: subscriptionPaymentSearchTerms('Acme'),
    });
  });

  it('an empty term adds no search clause', async () => {
    let where: Prisma.PaymentWhereInput | undefined;
    const tx = {
      payment: {
        findMany: jest.fn(async (args: { where: Prisma.PaymentWhereInput }) => {
          where = args.where;
          return [];
        }),
        count: jest.fn(async () => 0),
      },
    } as unknown as Prisma.TransactionClient;

    await new PaymentsRepository({} as PrismaService).findManyAnyOrganization(tx, {
      search: '   ',
      skip: 0,
      take: 20,
    });

    expect(where).not.toHaveProperty('OR');
  });
});
