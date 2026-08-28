/**
 * The `system` category's source — master plan §15's own description: "a
 * small fixed set of navigable system pages," no database table. Every
 * `path` is copied verbatim from the real frontend's `DASHBOARD_ROUTES`
 * (`route-paths.ts`) — never invented. `requiresPlatformOwner` entries are
 * stripped for a non-Platform-Owner caller before matching (never
 * surfaced then relied on the frontend to hide, matching the mandatory
 * server-side rule this phase applies to `platform`/`users` too).
 */
export interface SystemPageEntry {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly keywords: readonly string[];
  readonly requiresPlatformOwner: boolean;
}

export const SYSTEM_PAGES: readonly SystemPageEntry[] = [
  {
    id: 'profile',
    title: 'Profile',
    path: '/dashboard/profile',
    keywords: ['profile', 'account'],
    requiresPlatformOwner: false,
  },
  {
    id: 'settings',
    title: 'Settings',
    path: '/dashboard/settings',
    keywords: ['settings'],
    requiresPlatformOwner: false,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    path: '/dashboard/notifications',
    keywords: ['notifications', 'alerts'],
    requiresPlatformOwner: false,
  },
  {
    id: 'search',
    title: 'Search',
    path: '/dashboard/search',
    keywords: ['search'],
    requiresPlatformOwner: false,
  },
  {
    id: 'analytics',
    title: 'Analytics',
    path: '/dashboard/analytics',
    keywords: ['analytics', 'stats', 'metrics'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-dashboard',
    title: 'Platform Dashboard',
    path: '/dashboard/platform',
    keywords: ['platform', 'dashboard', 'command center'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-organizations',
    title: 'Platform Organizations',
    path: '/dashboard/platform/organizations',
    keywords: ['organizations', 'tenants'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-academies',
    title: 'Platform Academies',
    path: '/dashboard/platform/academies',
    keywords: ['academies'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-users',
    title: 'Platform Users',
    path: '/dashboard/platform/users',
    keywords: ['users', 'directory'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-roles-permissions',
    title: 'Roles & Permissions',
    path: '/dashboard/platform/roles-permissions',
    keywords: ['roles', 'permissions'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-audit-log',
    title: 'Audit Log',
    path: '/dashboard/platform/audit-log',
    keywords: ['audit', 'log', 'history'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-support',
    title: 'Support',
    path: '/dashboard/platform/support',
    keywords: ['support', 'cases', 'tickets'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-plan-catalog',
    title: 'Plans & Add-ons',
    path: '/dashboard/platform/plans',
    keywords: ['plans', 'add-ons', 'pricing'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-payments',
    title: 'Payment Review',
    path: '/dashboard/platform/payments',
    keywords: ['payments', 'billing', 'review'],
    requiresPlatformOwner: true,
  },
  {
    id: 'platform-provisioning',
    title: 'Provisioning',
    path: '/dashboard/platform/provisioning',
    keywords: ['provisioning', 'requests'],
    requiresPlatformOwner: true,
  },
];
