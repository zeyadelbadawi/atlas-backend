/**
 * G1 — the channel resolver (contract §1.1) and the self-reported answer
 * sanitiser.
 */
import {
  ACQUISITION_CHANNELS,
  SELF_REPORTED_CHANNELS,
  SPEND_CHANNELS,
  channelFromReferrer,
  channelFromUtm,
  resolveAcquisitionChannel,
  sanitizeSelfReportedSource,
} from './acquisition-channel';

describe('acquisition channel vocabulary', () => {
  it('has the 16 channels, the 11 self-reported options and spend without unknown', () => {
    expect(ACQUISITION_CHANNELS).toHaveLength(16);
    expect([...SELF_REPORTED_CHANNELS].sort()).toEqual(
      [
        'facebook',
        'youtube',
        'tiktok',
        'instagram',
        'whatsapp',
        'teacher_referral',
        'assistant_or_agency',
        'google_search',
        'ai_assistant',
        'event',
        'other',
      ].sort(),
    );
    expect(SPEND_CHANNELS).toHaveLength(15);
    expect(SPEND_CHANNELS).not.toContain('unknown');
  });
});

describe('channelFromUtm', () => {
  it.each([
    // paid mediums
    ['google', 'cpc', 'google_ads'],
    ['bing', 'cpc', 'google_ads'],
    ['Google', 'PAID', 'google_ads'],
    ['google', 'paid-social', 'google_ads'],
    ['facebook', 'cpc', 'meta_ads'],
    ['instagram', 'paid-social', 'meta_ads'],
    ['meta', 'paid', 'meta_ads'],
    ['fb', 'paid-social', 'meta_ads'],
    ['ig', 'cpc', 'meta_ads'],
    // a paid medium with another source falls back to the source mapping
    ['tiktok', 'cpc', 'tiktok'],
    ['youtube', 'paid', 'youtube'],
    ['newsletter', 'paid', 'email'],
    // organic, by source
    ['facebook', 'social', 'facebook'],
    ['fb', undefined, 'facebook'],
    ['instagram', undefined, 'instagram'],
    ['ig', 'social', 'instagram'],
    ['youtube', undefined, 'youtube'],
    ['yt', undefined, 'youtube'],
    ['tiktok', undefined, 'tiktok'],
    ['whatsapp', undefined, 'whatsapp'],
    ['wa', 'chat', 'whatsapp'],
    ['google', 'organic', 'google_search'],
    ['google', undefined, 'google_search'],
    ['email', undefined, 'email'],
    ['newsletter', 'email', 'email'],
    ['partner-acme', undefined, 'partner'],
    ['teacher-ahmed', undefined, 'teacher_referral'],
    ['chatgpt', undefined, 'ai_assistant'],
    ['gemini', undefined, 'ai_assistant'],
    ['perplexity', undefined, 'ai_assistant'],
    ['claude', undefined, 'ai_assistant'],
    ['copilot', undefined, 'ai_assistant'],
    // anything else
    ['bing', 'organic', 'other'],
    ['meta', 'social', 'other'],
    ['linkedin', undefined, 'other'],
    ['partner', undefined, 'other'],
    ['  TikTok  ', undefined, 'tiktok'],
  ])('%s / %s → %s', (source, medium, expected) => {
    expect(channelFromUtm(source, medium)).toBe(expected);
  });

  it('needs a source', () => {
    expect(channelFromUtm(undefined, 'cpc')).toBeNull();
    expect(channelFromUtm('   ', 'cpc')).toBeNull();
    expect(channelFromUtm(42, 'cpc')).toBeNull();
  });
});

describe('channelFromReferrer', () => {
  it.each([
    ['google.com', 'google_search'],
    ['www.google.com', 'google_search'],
    ['google.com.eg', 'google_search'],
    ['www.google.co.uk', 'google_search'],
    ['google.de', 'google_search'],
    ['GOOGLE.COM.', 'google_search'],
    ['facebook.com', 'facebook'],
    ['m.facebook.com', 'facebook'],
    ['l.facebook.com', 'facebook'],
    ['fb.com', 'facebook'],
    ['instagram.com', 'instagram'],
    ['l.instagram.com', 'instagram'],
    ['youtube.com', 'youtube'],
    ['m.youtube.com', 'youtube'],
    ['youtu.be', 'youtube'],
    ['tiktok.com', 'tiktok'],
    ['www.tiktok.com', 'tiktok'],
    ['wa.me', 'whatsapp'],
    ['whatsapp.com', 'whatsapp'],
    ['web.whatsapp.com', 'whatsapp'],
    // AI assistants are checked before google.*
    ['gemini.google.com', 'ai_assistant'],
    ['chatgpt.com', 'ai_assistant'],
    ['chat.openai.com', 'ai_assistant'],
    ['perplexity.ai', 'ai_assistant'],
    ['www.perplexity.ai', 'ai_assistant'],
    ['claude.ai', 'ai_assistant'],
    ['copilot.microsoft.com', 'ai_assistant'],
    // other search engines are NOT google_search
    ['bing.com', 'other'],
    ['www.bing.com', 'other'],
    ['duckduckgo.com', 'other'],
    ['yahoo.com', 'other'],
    ['search.yahoo.com', 'other'],
    // look-alikes
    ['google.example.net', 'other'],
    ['notfacebook.com', 'other'],
    ['facebook.com.evil.io', 'other'],
    ['openai.com', 'other'],
    ['news.example.org', 'other'],
  ])('%s → %s', (host, expected) => {
    expect(channelFromReferrer(host, 'atlas.example')).toBe(expected);
  });

  it('ignores the platform base domain and every subdomain of it', () => {
    expect(channelFromReferrer('atlas.example', 'atlas.example')).toBeNull();
    expect(channelFromReferrer('dashboard.atlas.example', 'atlas.example')).toBeNull();
    expect(channelFromReferrer('al-nour.atlas.example', 'ATLAS.EXAMPLE')).toBeNull();
    expect(channelFromReferrer('notatlas.example', 'atlas.example')).toBe('other');
  });

  it('no referrer → null; no base domain configured → nothing is ignored', () => {
    expect(channelFromReferrer(undefined, 'atlas.example')).toBeNull();
    expect(channelFromReferrer('', 'atlas.example')).toBeNull();
    expect(channelFromReferrer('dashboard.atlas.example', undefined)).toBe('other');
  });
});

describe('resolveAcquisitionChannel', () => {
  const base = 'atlas.example';

  it('1. the override wins over everything', () => {
    expect(
      resolveAcquisitionChannel({
        override: 'whatsapp',
        heardFrom: 'facebook',
        attribution: {
          utmSource: 'google',
          utmMedium: 'cpc',
          referrerDomain: 'tiktok.com',
        },
      }),
    ).toEqual({ channel: 'whatsapp', decidedBy: 'override' });
    expect(
      resolveAcquisitionChannel({ override: 'unknown', heardFrom: 'facebook' }),
    ).toEqual({
      channel: 'unknown',
      decidedBy: 'override',
    });
  });

  it('2. the self-reported answer beats UTM and referrer', () => {
    expect(
      resolveAcquisitionChannel({
        heardFrom: 'teacher_referral',
        attribution: { utmSource: 'google', utmMedium: 'cpc' },
      }),
    ).toEqual({ channel: 'teacher_referral', decidedBy: 'self_reported' });
  });

  it.each(SELF_REPORTED_CHANNELS.filter((c) => c !== 'other'))(
    'self-reported %s is used as is',
    (channel) => {
      expect(resolveAcquisitionChannel({ heardFrom: channel })).toEqual({
        channel,
        decidedBy: 'self_reported',
      });
    },
  );

  it('2→3. self-reported `other` falls through to UTM', () => {
    expect(
      resolveAcquisitionChannel({
        heardFrom: 'other',
        attribution: { utmSource: 'facebook', utmMedium: 'paid-social' },
      }),
    ).toEqual({ channel: 'meta_ads', decidedBy: 'utm' });
  });

  it('3. UTM beats the referrer', () => {
    expect(
      resolveAcquisitionChannel({
        attribution: { utmSource: 'newsletter', referrerDomain: 'facebook.com' },
        platformBaseDomain: base,
      }),
    ).toEqual({ channel: 'email', decidedBy: 'utm' });
  });

  it('3. an unmapped UTM source is `other` (by UTM), not the referrer', () => {
    expect(
      resolveAcquisitionChannel({
        attribution: { utmSource: 'linkedin', referrerDomain: 'facebook.com' },
      }),
    ).toEqual({ channel: 'other', decidedBy: 'utm' });
  });

  it('4. the referrer when there is no UTM source (a medium alone is not enough)', () => {
    expect(
      resolveAcquisitionChannel({
        attribution: { utmMedium: 'cpc', referrerDomain: 'www.google.com.eg' },
        platformBaseDomain: base,
      }),
    ).toEqual({ channel: 'google_search', decidedBy: 'referrer' });
  });

  it('4→5. an internal referrer is ignored; self-reported other is then used', () => {
    expect(
      resolveAcquisitionChannel({
        heardFrom: 'other',
        attribution: {
          referrerDomain: 'dashboard.atlas.example',
          landingTemplate: 'home',
        },
        platformBaseDomain: base,
      } as never),
    ).toEqual({ channel: 'other', decidedBy: 'self_reported_other' });
  });

  it('5. self-reported other with no other signal', () => {
    expect(resolveAcquisitionChannel({ heardFrom: 'other', attribution: null })).toEqual({
      channel: 'other',
      decidedBy: 'self_reported_other',
    });
  });

  it('6. nothing at all → unknown', () => {
    expect(resolveAcquisitionChannel({})).toEqual({
      channel: 'unknown',
      decidedBy: 'none',
    });
    expect(
      resolveAcquisitionChannel({
        override: null,
        heardFrom: null,
        attribution: { referrerDomain: 'atlas.example' },
        platformBaseDomain: base,
      }),
    ).toEqual({ channel: 'unknown', decidedBy: 'none' });
  });

  it('a stored heard_from of unknown is treated as no answer', () => {
    expect(resolveAcquisitionChannel({ heardFrom: 'unknown' })).toEqual({
      channel: 'unknown',
      decidedBy: 'none',
    });
  });
});

describe('sanitizeSelfReportedSource', () => {
  it('keeps the channel; free text only with other', () => {
    expect(sanitizeSelfReportedSource('facebook', 'my cousin')).toEqual({
      heardFrom: 'facebook',
      heardFromOther: null,
    });
    expect(sanitizeSelfReportedSource('other', '  a  Telegram\u0000 group ')).toEqual({
      heardFrom: 'other',
      heardFromOther: 'a Telegram group',
    });
  });

  it('drops email- or phone-like text and never throws', () => {
    expect(sanitizeSelfReportedSource('other', 'ahmed@example.com')).toEqual({
      heardFrom: 'other',
      heardFromOther: null,
    });
    expect(sanitizeSelfReportedSource('other', 'call 0100 123 4567')).toEqual({
      heardFrom: 'other',
      heardFromOther: null,
    });
    expect(sanitizeSelfReportedSource('other', 'ahmed%40example.com')).toEqual({
      heardFrom: 'other',
      heardFromOther: null,
    });
    expect(sanitizeSelfReportedSource('other', '   ')).toEqual({
      heardFrom: 'other',
      heardFromOther: null,
    });
  });

  it('caps at 100 characters', () => {
    const result = sanitizeSelfReportedSource('other', 'x'.repeat(150));
    expect(result?.heardFromOther).toHaveLength(100);
  });

  it('no answer, or a value outside the self-reported options → nothing', () => {
    expect(sanitizeSelfReportedSource(undefined, 'x')).toBeNull();
    expect(sanitizeSelfReportedSource(null, null)).toBeNull();
    expect(sanitizeSelfReportedSource('google_ads' as never, null)).toBeNull();
  });
});
