import sharp from 'sharp';
import {
  AVATAR_SIZE,
  UserAvatarService,
  avatarKeyOf,
  encodeAvatar,
} from './user-avatar.service';

const KEY = 'users/avatars/0b8f3c1e-2d4a-4f6b-9c7d-1e2f3a4b5c6d.webp';
const URL = `/api/v1/public/media/${KEY}`;

function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 27, g: 57, b: 141 } },
  })
    .jpeg()
    .toBuffer();
}

describe('encodeAvatar', () => {
  it('crops any photo to a 512 x 512 WebP', async () => {
    const out = await encodeAvatar(await jpeg(900, 400));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([AVATAR_SIZE, AVATAR_SIZE]);
  });

  it('refuses bytes that are not an image', async () => {
    await expect(encodeAvatar(Buffer.from('not an image at all'))).rejects.toMatchObject({
      response: { messageKey: 'errors.profile.avatarInvalid' },
    });
  });
});

describe('avatarKeyOf', () => {
  it('maps only our own avatar URLs back to their key', () => {
    expect(avatarKeyOf(URL)).toBe(KEY);
    expect(avatarKeyOf('https://example.com/me.png')).toBeNull();
    expect(avatarKeyOf('/api/v1/public/media/users/avatars/../secret.webp')).toBeNull();
    expect(avatarKeyOf(null)).toBeNull();
  });
});

describe('UserAvatarService', () => {
  function make(before?: string) {
    const storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    const usersService = {
      getCurrent: jest.fn().mockResolvedValue({ avatar: before }),
      updateProfile: jest.fn(async (_id: string, input: { avatar: string }) => ({
        avatar: input.avatar,
      })),
      clearAvatar: jest.fn().mockResolvedValue({ avatar: undefined }),
    };
    const writes: unknown[] = [];
    const tenancy = {
      runInUserContext: jest.fn((_id: string, fn: (tx: unknown) => unknown) => fn({})),
    };
    const audit = {
      write: jest.fn((_tx: unknown, entry: unknown) => writes.push(entry)),
    };
    const service = new UserAvatarService(
      storage as never,
      usersService as never,
      tenancy as never,
      audit as never,
    );
    return { service, storage, usersService, writes };
  }

  it('stores a new WebP, points the account at it and deletes the old one', async () => {
    const { service, storage, writes } = make(URL);
    const user = await service.upload('u1', { buffer: await jpeg(200, 300), size: 1 });
    const [key, body, type] = storage.putObject.mock.calls[0];
    expect(key).toMatch(/^users\/avatars\/[0-9a-f-]{36}\.webp$/);
    expect(type).toBe('image/webp');
    expect(user.avatar).toBe(`/api/v1/public/media/${key}`);
    expect(storage.deleteObject).toHaveBeenCalledWith(KEY);
    expect(writes).toEqual([
      expect.objectContaining({
        action: 'account.avatar.updated',
        context: { sizeBytes: (body as Buffer).length },
      }),
    ]);
  });

  it('never deletes an avatar URL it did not create', async () => {
    const { service, storage } = make('https://cdn.example.com/a.png');
    await service.upload('u1', { buffer: await jpeg(64, 64), size: 1 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('removes the photo and its object', async () => {
    const { service, storage, writes } = make(URL);
    expect((await service.remove('u1')).avatar).toBeUndefined();
    expect(storage.deleteObject).toHaveBeenCalledWith(KEY);
    expect(writes).toEqual([
      expect.objectContaining({ action: 'account.avatar.removed' }),
    ]);
  });

  it('refuses an upload with no file', async () => {
    const { service } = make();
    await expect(service.upload('u1', undefined)).rejects.toMatchObject({
      response: { messageKey: 'errors.profile.avatarInvalid' },
    });
  });
});
