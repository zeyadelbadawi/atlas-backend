/**
 * Every button slot of every section that has buttons is checked: a page or
 * course a button points at must be this Academy's own. The third button and
 * the About section's buttons (CMS phase 3) are checked like the others.
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SectionReferenceValidatorService } from './section-reference-validator.service';
import type { ValidatedSectionInstance } from '../validation/section-config.schemas';

const ACADEMY = 'academy-1';
const tx = {} as Prisma.TransactionClient;
const label = { en: 'Go', ar: '' };

function service() {
  const courses = new Map([
    ['own-course', { id: 'own-course', academyId: ACADEMY }],
    ['other-course', { id: 'other-course', academyId: 'academy-2' }],
  ]);
  return new SectionReferenceValidatorService(
    {
      findById: jest.fn(async (_tx: unknown, id: string) => courses.get(id) ?? null),
    } as never,
    { findAllForAcademy: jest.fn(async () => [{ id: 'home' }]) } as never,
    { findAllForAcademy: jest.fn(async () => []) } as never,
    { findAllForAcademy: jest.fn(async () => []) } as never,
  );
}

function section(
  type: string,
  config: Record<string, unknown>,
): ValidatedSectionInstance {
  return {
    id: `${type}-1`,
    type,
    enabled: true,
    visibility: { desktop: true, tablet: true, mobile: true },
    config,
  } as unknown as ValidatedSectionInstance;
}

async function violations(sections: ValidatedSectionInstance[]): Promise<string[]> {
  try {
    await service().validateSectionReferences(tx, ACADEMY, sections);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      violations: { field: string }[];
    };
    return body.violations.map((violation) => violation.field);
  }
}

describe('SectionReferenceValidatorService — section buttons', () => {
  it('accepts buttons that point at this Academy’s own page and course', async () => {
    expect(
      await violations([
        section('about', {
          cta: { label, pageId: 'home' },
          secondaryCta: { label, courseId: 'own-course' },
          tertiaryCta: { label, whatsapp: '+201001234567' },
        }),
      ]),
    ).toEqual([]);
  });

  it('checks the third button of a hero, a CTA band and a feature split', async () => {
    expect(
      await violations([
        section('hero', { tertiaryCta: { label, pageId: 'gone' } }),
        section('cta', {
          cta: { label, pageId: 'home' },
          tertiaryCta: { label, courseId: 'other-course' },
        }),
        section('featureSplit', { secondaryCta: { label, pageId: 'missing' } }),
      ]),
    ).toEqual(['courseId:other-course', 'pageId:gone', 'pageId:missing']);
  });

  it('checks the About section’s buttons', async () => {
    expect(
      await violations([
        section('about', { secondaryCta: { label, courseId: 'other-course' } }),
      ]),
    ).toEqual(['courseId:other-course']);
  });
});

describe('SectionReferenceValidatorService — CMS phase 3d sections', () => {
  it('checks every button of a WhatsApp bar and a countdown', async () => {
    expect(
      await violations([
        section('whatsappBar', {
          cta: { label, whatsapp: '+201001234567' },
          secondaryCta: { label, pageId: 'gone' },
          tertiaryCta: { label, courseId: 'own-course' },
        }),
        section('countdown', {
          deadline: '',
          cta: { label, pageId: 'home' },
          tertiaryCta: { label, courseId: 'other-course' },
        }),
      ]),
    ).toEqual(['courseId:other-course', 'pageId:gone']);
  });

  it('checks the button of every pricing plan', async () => {
    expect(
      await violations([
        section('pricing', {
          plans: [
            { id: 'a', features: [], cta: { label, pageId: 'home' } },
            { id: 'b', features: [] },
            { id: 'c', features: [], cta: { label, courseId: 'other-course' } },
            { id: 'd', features: [], cta: { label, pageId: 'missing' } },
          ],
        }),
      ]),
    ).toEqual(['courseId:other-course', 'pageId:missing']);
  });
});

describe('SectionReferenceValidatorService — CMS phase 3d (batch C)', () => {
  it('checks the notice strip’s button', async () => {
    expect(
      await violations([
        section('announcementBar', {
          text: label,
          tone: 'brand',
          cta: { label, pageId: 'gone' },
        }),
        section('announcementBar', {
          text: label,
          tone: 'dark',
          cta: { label, courseId: 'own-course' },
        }),
      ]),
    ).toEqual(['pageId:gone']);
  });
});
