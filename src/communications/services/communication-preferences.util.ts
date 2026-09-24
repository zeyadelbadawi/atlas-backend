/**
 * Communication preferences — P64 Communications C3.
 *
 * Resolves `users.preferences` into the one shape every reader uses: the
 * dispatcher (should this email go out, now or in a digest) and
 * `GET /users/me/communication-preferences` (what the person sees). The
 * two can never disagree because there is one resolver.
 *
 * Security, transactional and lifecycle emails are LOCKED on: a person
 * cannot opt out of being told their password changed, their payment was
 * rejected or their certificate was revoked. Engagement is the only
 * category a learner can silence; operational exists only for staff.
 *
 * Storage: `preferences.language` (existing) and
 * `preferences.notifications.categories` (new), next to the legacy
 * `notifications.email/push/sms` flags. Backward compatibility: a legacy
 * `notifications.email = false` with no explicit engagement setting turns
 * engagement email off — and only engagement, because that was the only
 * category the old flag could ever silence without breaking a transaction.
 */
import type { CommunicationLocale } from '../catalog/communication-catalog';

export type DigestMode = 'immediate' | 'daily' | 'off';
export type StaffDigestMode = 'immediate' | 'daily';

export interface CommunicationPreferences {
  readonly language: CommunicationLocale;
  readonly categories: {
    readonly security: { readonly email: true; readonly locked: true };
    readonly transactional: { readonly email: true; readonly locked: true };
    readonly lifecycle: {
      readonly email: true;
      readonly locked: true;
      readonly reminders: boolean;
    };
    readonly engagement: { readonly email: boolean; readonly digest: DigestMode };
    readonly operational: {
      readonly email: boolean;
      readonly digest: StaffDigestMode;
    } | null;
  };
}

/** What is actually persisted under `preferences.notifications.categories`. */
export interface StoredCommunicationCategories {
  readonly lifecycle?: { readonly reminders?: boolean };
  readonly engagement?: { readonly email?: boolean; readonly digest?: DigestMode };
  readonly operational?: { readonly email?: boolean; readonly digest?: StaffDigestMode };
}

export interface ResolveOptions {
  /** Whether the person holds any staff membership — decides if `operational` exists. */
  readonly isStaff: boolean;
}

function isLocale(value: unknown): value is CommunicationLocale {
  return value === 'en' || value === 'ar';
}

function isDigestMode(value: unknown): value is DigestMode {
  return value === 'immediate' || value === 'daily' || value === 'off';
}

function isStaffDigestMode(value: unknown): value is StaffDigestMode {
  return value === 'immediate' || value === 'daily';
}

export function resolveCommunicationPreferences(
  preferencesJson: unknown,
  options: ResolveOptions,
): CommunicationPreferences {
  const prefs = (preferencesJson ?? {}) as {
    language?: unknown;
    notifications?: {
      email?: unknown;
      categories?: StoredCommunicationCategories;
    } | null;
  };
  const notifications = prefs.notifications ?? {};
  const categories = notifications.categories ?? {};
  const legacyEmailOff = notifications.email === false;

  const engagementEmail =
    typeof categories.engagement?.email === 'boolean'
      ? categories.engagement.email
      : !legacyEmailOff;

  return {
    language: isLocale(prefs.language) ? prefs.language : 'en',
    categories: {
      security: { email: true, locked: true },
      transactional: { email: true, locked: true },
      lifecycle: {
        email: true,
        locked: true,
        reminders: categories.lifecycle?.reminders ?? true,
      },
      engagement: {
        email: engagementEmail,
        digest: isDigestMode(categories.engagement?.digest)
          ? categories.engagement.digest
          : 'immediate',
      },
      operational: options.isStaff
        ? {
            email: categories.operational?.email ?? true,
            digest: isStaffDigestMode(categories.operational?.digest)
              ? categories.operational.digest
              : 'immediate',
          }
        : null,
    },
  };
}
