/**
 * B0-WEB-11 — deleting a custom page left every menu entry pointing at it
 * in the draft navigation/header/footer (and in the published snapshot).
 * The public renderer already drops a link whose page is gone, but the
 * Owner's next save of those areas was then refused by the reference
 * validator (`errors.website.pageNotFound`) until they found and removed
 * the dead entry by hand.
 *
 * `pruneDeletedPageReferences` removes exactly the entries that target the
 * deleted page — a navigation item, a footer link or social link, and the
 * header call to action — and leaves everything else (groups, order, other
 * links) as it was. Shapes are read defensively: the columns are JSONB, so
 * anything unexpected is passed through untouched.
 */

type Json = unknown;

export interface WebsiteChromeReferences {
  readonly navigation: Json;
  readonly header: Json;
  readonly footer: Json;
}

export interface PrunedChrome extends WebsiteChromeReferences {
  readonly changed: boolean;
}

function isRecord(value: Json): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function targets(value: Json, pageId: string): boolean {
  return isRecord(value) && value.pageId === pageId;
}

function withoutTargets(list: Json, pageId: string): { value: Json; changed: boolean } {
  if (!Array.isArray(list)) return { value: list, changed: false };
  const kept = list.filter((item) => !targets(item, pageId));
  return { value: kept, changed: kept.length !== list.length };
}

export function pruneDeletedPageReferences(
  chrome: WebsiteChromeReferences,
  pageId: string,
): PrunedChrome {
  let changed = false;

  const navigation = withoutTargets(chrome.navigation, pageId);
  changed ||= navigation.changed;

  let header = chrome.header;
  if (isRecord(header) && targets(header.cta, pageId)) {
    const rest: Record<string, unknown> = { ...header };
    delete rest.cta;
    header = rest;
    changed = true;
  }

  let footer = chrome.footer;
  if (isRecord(footer)) {
    const next: Record<string, unknown> = { ...footer };
    if (Array.isArray(footer.groups)) {
      next.groups = footer.groups.map((group) => {
        if (!isRecord(group)) return group;
        const links = withoutTargets(group.links, pageId);
        if (!links.changed) return group;
        changed = true;
        return { ...group, links: links.value };
      });
    }
    const social = withoutTargets(footer.socialLinks, pageId);
    if (social.changed) {
      next.socialLinks = social.value;
      changed = true;
    }
    footer = next;
  }

  return { navigation: navigation.value, header, footer, changed };
}
