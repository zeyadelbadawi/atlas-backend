import { bullConnectionFromRedisUrl } from './bull-connection.util';

describe('bullConnectionFromRedisUrl', () => {
  it('keeps the existing shape for a plain local URL', () => {
    expect(bullConnectionFromRedisUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      password: undefined,
      db: 0,
      maxRetriesPerRequest: null,
    });
  });

  it('keeps the database index, username and a decoded password', () => {
    expect(
      bullConnectionFromRedisUrl('redis://atlas:p%40ss%3Aw%2Frd@redis:6380/3'),
    ).toEqual({
      host: 'redis',
      port: 6380,
      username: 'atlas',
      password: 'p@ss:w/rd',
      db: 3,
      maxRetriesPerRequest: null,
    });
  });

  it('keeps a password with a malformed escape as written', () => {
    expect(bullConnectionFromRedisUrl('redis://:100%zz@redis:6379')).toMatchObject({
      password: '100%zz',
    });
  });

  it('enables TLS for rediss://', () => {
    expect(
      bullConnectionFromRedisUrl('rediss://:secret@cache.example.com'),
    ).toMatchObject({
      host: 'cache.example.com',
      port: 6379,
      password: 'secret',
      tls: { servername: 'cache.example.com' },
    });
  });

  it('refuses other schemes and a malformed database index', () => {
    expect(() => bullConnectionFromRedisUrl('http://localhost:6379')).toThrow();
    expect(() => bullConnectionFromRedisUrl('redis://localhost:6379/x')).toThrow();
  });
});
