/**
 * BrandImagesService — draws an Academy's generated share card and
 * monogram (`brand-images.util.ts`) with sharp, from its name and public
 * brand colour only.
 *
 * Text is set by Pango (inside sharp) in the Noto fonts the image already
 * ships for certificates (`assets/fonts`, OFL) — Latin and Arabic, shaped
 * and right-to-left as needed. The runtime image has no system fonts, so a
 * fontconfig file naming that folder is written once and named in
 * `FONTCONFIG_FILE` before the first text is drawn (an operator's own
 * `FONTCONFIG_FILE` is kept).
 *
 * Rendered images are kept in a small bounded in-memory cache keyed by the
 * academy and the version, so a crawler storm costs one render each.
 */
import { Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  brandImageVersion,
  cardFontSize,
  displayName,
  escapeMarkup,
  hslTripletToRgb,
  monogramLetter,
  rgbToHex,
  textColorOn,
  type MonogramSize,
} from '../utils/brand-images.util';

export interface BrandImageSubject {
  readonly name: string;
  readonly primaryColor?: string;
}

export interface RenderedBrandImage {
  readonly png: Buffer;
  /** The version this image was drawn for (`brandImageVersion`). */
  readonly version: string;
}

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const CACHE_LIMIT = 200;

const FONT_DIRS = [
  resolve(process.cwd(), 'assets/fonts'),
  resolve(__dirname, '../../../assets/fonts'),
  resolve(__dirname, '../../../../assets/fonts'),
];

let fontsConfigured = false;

/** Points fontconfig at the bundled Noto fonts (once per process). */
export function configureBundledFonts(): void {
  if (fontsConfigured) return;
  fontsConfigured = true;
  if (process.env.FONTCONFIG_FILE) return;
  const fontDir = FONT_DIRS.find((dir) => existsSync(join(dir, 'NotoSans-Bold.ttf')));
  if (!fontDir) return;
  const dir = join(tmpdir(), 'atlas-fontconfig');
  mkdirSync(join(dir, 'cache'), { recursive: true });
  const file = join(dir, 'fonts.conf');
  writeFileSync(
    file,
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      `  <dir>${fontDir}</dir>`,
      `  <cachedir>${join(dir, 'cache')}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n'),
  );
  process.env.FONTCONFIG_FILE = file;
}

/** Latin first, Arabic for what Latin lacks. */
const FONT_FAMILY = 'Noto Sans, Noto Sans Arabic';

@Injectable()
export class BrandImagesService {
  private readonly logger = new Logger(BrandImagesService.name);
  private readonly cache = new Map<string, Buffer>();

  async renderCard(
    academyId: string,
    subject: BrandImageSubject,
  ): Promise<RenderedBrandImage> {
    const version = brandImageVersion(subject.name, subject.primaryColor);
    const key = `card|${academyId}|${version}`;
    const png = await this.cached(key, async () => {
      configureBundledFonts();
      const background = hslTripletToRgb(subject.primaryColor);
      const foreground = textColorOn(background);
      const name = displayName(subject.name);
      const fontSize = cardFontSize(name);
      const title = await this.text(
        `<span foreground="${foreground}" weight="bold">${escapeMarkup(name)}</span>`,
        `${FONT_FAMILY} Bold ${fontSize}px`,
        CARD_WIDTH - 160,
      );
      const fitted = await sharp(title)
        .resize({
          width: CARD_WIDTH - 160,
          height: CARD_HEIGHT - 200,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toBuffer({ resolveWithObject: true });
      const titleWidth = fitted.info.width;
      const titleHeight = fitted.info.height;
      const barWidth = 120;
      const bar = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${barWidth}" height="8"><rect width="${barWidth}" height="8" rx="4" fill="${foreground}" fill-opacity="0.85"/></svg>`,
      );
      // Title and bar centred as one block.
      const blockHeight = titleHeight + 40;
      const top = Math.max(40, Math.round((CARD_HEIGHT - blockHeight) / 2));
      return sharp({
        create: {
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          channels: 4,
          background: rgbToHex(background),
        },
      })
        .composite([
          {
            input: fitted.data,
            top,
            left: Math.round((CARD_WIDTH - titleWidth) / 2),
          },
          {
            input: bar,
            top: top + titleHeight + 32,
            left: Math.round((CARD_WIDTH - barWidth) / 2),
          },
        ])
        .png({ compressionLevel: 9 })
        .toBuffer();
    });
    return { png, version };
  }

  async renderMonogram(
    academyId: string,
    subject: BrandImageSubject,
    size: MonogramSize,
  ): Promise<RenderedBrandImage> {
    const version = brandImageVersion(subject.name, subject.primaryColor);
    const key = `icon|${academyId}|${version}|${size}`;
    const png = await this.cached(key, async () => {
      configureBundledFonts();
      const background = hslTripletToRgb(subject.primaryColor);
      const foreground = textColorOn(background);
      const letter = await this.text(
        `<span foreground="${foreground}" weight="bold">${escapeMarkup(monogramLetter(subject.name))}</span>`,
        `${FONT_FAMILY} Bold ${Math.round(size * 0.56)}px`,
        size,
      );
      const radius = Math.round(size * 0.22);
      const tile = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${rgbToHex(background)}"/></svg>`,
      );
      const fitted = await sharp(letter)
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      return sharp(tile)
        .composite([{ input: fitted, gravity: 'centre' }])
        .png({ compressionLevel: 9 })
        .toBuffer();
    });
    return { png, version };
  }

  private async text(markup: string, font: string, width: number): Promise<Buffer> {
    return sharp({
      text: {
        text: markup,
        font,
        width,
        align: 'centre',
        wrap: 'word-char',
        rgba: true,
        dpi: 72,
      },
    })
      .png()
      .toBuffer();
  }

  private async cached(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const started = Date.now();
    const png = await render();
    this.cache.set(key, png);
    while (this.cache.size > CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    this.logger.debug(`rendered ${key.split('|')[0]} in ${Date.now() - started} ms`);
    return png;
  }
}
