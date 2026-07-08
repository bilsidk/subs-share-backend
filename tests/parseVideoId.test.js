const { parseVideoId } = require('../src/services/youtubeService');

const ID = 'dQw4w9WgXcQ'; // valid 11-char id

describe('parseVideoId — accepts extra params, extracts the video id', () => {
  test('watch?v=', () => expect(parseVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID));
  test('watch?v= with &list= (playlist)', () => expect(parseVideoId(`https://www.youtube.com/watch?v=${ID}&list=PLabc123`)).toBe(ID));
  test('watch?v= with &t= (start time)', () => expect(parseVideoId(`https://www.youtube.com/watch?v=${ID}&t=42s`)).toBe(ID));
  test('watch?v= with list + index + t combined', () => expect(parseVideoId(`https://www.youtube.com/watch?v=${ID}&list=PLx&index=3&t=10s`)).toBe(ID));
  test('youtu.be short link', () => expect(parseVideoId(`https://youtu.be/${ID}`)).toBe(ID));
  test('youtu.be with ?si= and t', () => expect(parseVideoId(`https://youtu.be/${ID}?si=abcd&t=10`)).toBe(ID));
  test('shorts with params', () => expect(parseVideoId(`https://youtube.com/shorts/${ID}?feature=share`)).toBe(ID));
  test('bare 11-char id', () => expect(parseVideoId(ID)).toBe(ID));
});

describe('parseVideoId — rejects what it should', () => {
  test('pure playlist link → null', () => expect(parseVideoId('https://www.youtube.com/playlist?list=PLabc')).toBeNull());
  test('live URL → null (unsupported format)', () => expect(parseVideoId(`https://www.youtube.com/live/${ID}`)).toBeNull());
  test('embed URL → null (unsupported format)', () => expect(parseVideoId(`https://www.youtube.com/embed/${ID}`)).toBeNull());
  test('empty → null', () => expect(parseVideoId('')).toBeNull());
  test('garbage → null', () => expect(parseVideoId('hello world')).toBeNull());
  test('null/undefined → null', () => { expect(parseVideoId(null)).toBeNull(); expect(parseVideoId(undefined)).toBeNull(); });
});
