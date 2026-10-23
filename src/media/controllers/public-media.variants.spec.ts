/**
 * CMS phase 4 — `?w=&f=` on the public media route: the closest stored
 * variant with its own type and the original's caching; the original (never
 * a 404) with a short cache when no variant exists yet; a 400 for anything
 * but a well-formed pair.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicMediaController, parseVariantRequest } from './public-media.controller';
import type { MediaStorageProvider } from '../storage/media-storage.interface';
import type {
  PublicMediaAccessService,
  PublicMediaResolution,
} from '../services/public-media-access.service';
import type { PublicMediaLinkSigner } from '../services/public-media-link.signer';

const ACADEMY = '11111111-1111-4111-8111-111111111111';
const NAME = '22222222-2222-4222-8222-222222222222';
const KEY = `academies/${ACADEMY}/${NAME}.jpg`;
const VARIANT = (width: number, format: string) =>
  `academies/${ACADEMY}/variants/${NAME}/w${width}.${format}`;

function setup(
  resolution: PublicMediaResolution | null,
  objects: Record<string, string>,
) {
  const storage = {
    getObject: jest.fn(async (key: string) => {
      if (!(key in objects)) throw new Error('NoSuchKey');
      return Buffer.from(objects[key]);
    }),
  } as unknown as MediaStorageProvider;
  const access = {
    resolveWithVariants: jest.fn(async () => resolution),
  } as unknown as PublicMediaAccessService;
  const links = { verify: () => true } as unknown as PublicMediaLinkSigner;
  return new PublicMediaController(storage, access, links);
}

function fakeResponse() {
  const headers: Record<string, unknown> = {};
  let status = 0;
  let body: Buffer | undefined;
  const response = {
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
    status: (code: number) => {
      status = code;
      return { end: (data?: Buffer) => (body = data) };
    },
  } as unknown as Response;
  return { response, read: () => ({ headers, status, body: body?.toString() }) };
}

const request = { headers: {} } as Request;
const variants = [480, 960, 1000].flatMap((width) =>
  ['avif', 'webp'].map((format) => ({ width, height: width / 2, format, sizeBytes: 1 })),
);
const objects = {
  [KEY]: 'original',
  ...Object.fromEntries(
    variants.map((variant) => [
      VARIANT(variant.width, variant.format),
      `${variant.width}.${variant.format}`,
    ]),
  ),
};

describe('public media variants', () => {
  it('serves the closest variant at least as wide as asked, typed and cached like the original', async () => {
    const controller = setup({ access: 'branding', variants }, objects);
    const { response, read } = fakeResponse();
    await controller.serve(
      ACADEMY,
      `${NAME}.jpg`,
      undefined,
      undefined,
      '700',
      'avif',
      request,
      response,
    );
    expect(read()).toMatchObject({
      status: 200,
      body: '960.avif',
      headers: {
        'Content-Type': 'image/avif',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });

  it('serves the widest variant when asked for more than exists', async () => {
    const controller = setup({ access: 'public', variants }, objects);
    const { response, read } = fakeResponse();
    await controller.serve(
      ACADEMY,
      `${NAME}.jpg`,
      undefined,
      undefined,
      '1600',
      'webp',
      request,
      response,
    );
    expect(read()).toMatchObject({
      body: '1000.webp',
      headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' },
    });
  });

  it('falls back to the original, briefly cached, when no variant exists yet', async () => {
    const controller = setup(
      { access: 'branding', variants: null },
      { [KEY]: 'original' },
    );
    const { response, read } = fakeResponse();
    await controller.serve(
      ACADEMY,
      `${NAME}.jpg`,
      undefined,
      undefined,
      '480',
      'avif',
      request,
      response,
    );
    expect(read()).toMatchObject({
      status: 200,
      body: 'original',
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300' },
    });
  });

  it('falls back to the original when a listed variant object is missing', async () => {
    const controller = setup({ access: 'branding', variants }, { [KEY]: 'original' });
    const { response, read } = fakeResponse();
    await controller.serve(
      ACADEMY,
      `${NAME}.jpg`,
      undefined,
      undefined,
      '480',
      'webp',
      request,
      response,
    );
    expect(read()).toMatchObject({
      body: 'original',
      headers: { 'Content-Type': 'image/jpeg' },
    });
  });

  it('leaves a request without the query exactly as before', async () => {
    const controller = setup({ access: 'branding', variants }, objects);
    const { response, read } = fakeResponse();
    await controller.serve(
      ACADEMY,
      `${NAME}.jpg`,
      undefined,
      undefined,
      undefined,
      undefined,
      request,
      response,
    );
    expect(read()).toMatchObject({
      body: 'original',
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });

  it('still refuses what may not be served at all', async () => {
    const controller = setup(null, objects);
    const { response } = fakeResponse();
    await expect(
      controller.serve(
        ACADEMY,
        `${NAME}.jpg`,
        undefined,
        undefined,
        '480',
        'avif',
        request,
        response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('parseVariantRequest', () => {
  it('accepts a positive width with avif or webp, and nothing at all', () => {
    expect(parseVariantRequest(undefined, undefined)).toBeNull();
    expect(parseVariantRequest('480', 'avif')).toEqual({ width: 480, format: 'avif' });
    expect(parseVariantRequest('4096', 'webp')).toEqual({ width: 4096, format: 'webp' });
  });

  it('refuses a partial or malformed pair', () => {
    for (const [w, f] of [
      ['480', undefined],
      [undefined, 'avif'],
      ['0', 'avif'],
      ['048', 'avif'],
      ['4097', 'avif'],
      ['480px', 'avif'],
      ['480', 'png'],
      ['480', 'AVIF'],
    ] as const) {
      expect(() => parseVariantRequest(w, f)).toThrow(BadRequestException);
    }
  });
});
