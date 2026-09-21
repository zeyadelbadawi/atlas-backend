import { classifyExternalEmbed } from './external-embed.util';

describe('classifyExternalEmbed', () => {
  const ID = 'dQw4w9WgXcQ';

  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123&index=2`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
  ])('recognises %s', (url) => {
    expect(classifyExternalEmbed(url)).toEqual({ provider: 'youtube', videoId: ID });
  });

  it('carries a start offset in every shape YouTube writes it', () => {
    expect(classifyExternalEmbed(`https://youtu.be/${ID}?t=90`)).toMatchObject({
      startSeconds: 90,
    });
    expect(classifyExternalEmbed(`https://youtu.be/${ID}?t=90s`)).toMatchObject({
      startSeconds: 90,
    });
    expect(
      classifyExternalEmbed(`https://www.youtube.com/watch?v=${ID}&t=1m30s`),
    ).toMatchObject({
      startSeconds: 90,
    });
    expect(
      classifyExternalEmbed(`https://www.youtube.com/watch?v=${ID}&start=2h`),
    ).toMatchObject({
      startSeconds: 7200,
    });
    expect(classifyExternalEmbed(`https://youtu.be/${ID}?t=abc`)).toEqual({
      provider: 'youtube',
      videoId: ID,
    });
    expect(classifyExternalEmbed(`https://youtu.be/${ID}?t=0`)).toEqual({
      provider: 'youtube',
      videoId: ID,
    });
  });

  it.each([
    'https://example.com/embed/lesson',
    'https://vimeo.com/123456',
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/?redirect=https://youtube.com/watch?v=${ID}`,
    'https://www.youtube.com/channel/UCabcdefgh',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/watch?v=<script>alert1',
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `ftp://youtube.com/watch?v=${ID}`,
    'not a url',
    '',
    null,
    undefined,
  ])('refuses %s', (url) => {
    expect(classifyExternalEmbed(url as string)).toBeNull();
  });
});
