/**
 * G1 — one organization's acquisition: the resolved channel, how it was
 * decided, the Platform Owner override, the self-reported answer and the
 * stored signup attribution. Shared by `PATCH
 * platform-growth/organizations/:id/channel` and the Platform Owner
 * organization detail (`GET /organizations/:id`), which adds it
 * additively. Runs in the caller's (Platform Owner) transaction: the
 * `organizations_platform_select` and `organization_platform_flags_platform_*`
 * policies grant the reads.
 */
import type { Prisma } from '@prisma/client';
import {
  resolveAcquisitionChannel,
  type SelfReportedChannel,
} from '../common/attribution/acquisition-channel';
import type { OrganizationAcquisitionResponse } from './dto/growth.contract';
import { userNames } from './user-names';

export function attributionObject(
  value: Prisma.JsonValue | null,
): Record<string, string> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;
}

/** `null` when the organization does not exist (or RLS hides it). */
export async function readOrganizationAcquisition(
  tx: Prisma.TransactionClient,
  organizationId: string,
  platformBaseDomain: string | null | undefined,
): Promise<OrganizationAcquisitionResponse | null> {
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    select: {
      heardFrom: true,
      heardFromOther: true,
      signupAttribution: true,
      platformFlags: {
        select: {
          acquisitionChannelOverride: true,
          acquisitionOverrideNote: true,
          updatedAt: true,
          updatedByUserId: true,
        },
      },
    },
  });
  if (!organization) return null;
  const flags = organization.platformFlags;
  const override = flags?.acquisitionChannelOverride ?? null;
  const attribution = attributionObject(organization.signupAttribution);
  const resolved = resolveAcquisitionChannel({
    override,
    heardFrom: organization.heardFrom,
    attribution,
    platformBaseDomain,
  });
  const names = override ? await userNames(tx, [flags?.updatedByUserId]) : new Map();
  return {
    resolvedChannel: resolved.channel,
    decidedBy: resolved.decidedBy,
    override: override
      ? {
          channel: override,
          note: flags?.acquisitionOverrideNote ?? null,
          updatedAt: flags?.updatedAt.toISOString() ?? null,
          updatedByName: flags?.updatedByUserId
            ? (names.get(flags.updatedByUserId) ?? null)
            : null,
        }
      : null,
    heardFrom: (organization.heardFrom as SelfReportedChannel | null) ?? null,
    heardFromOther: organization.heardFromOther ?? null,
    attribution,
  };
}
