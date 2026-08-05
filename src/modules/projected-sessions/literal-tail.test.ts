import { describe, expect, it } from 'vitest';

import { parseText } from './literal-tail.js';

describe('parseText', () => {
  it('returns the text field when present', () => {
    expect(parseText(JSON.stringify({ text: 'hello' }))).toBe('hello');
  });

  it('renders a bracketed placeholder for a captionless attachment instead of dumping raw JSON', () => {
    const content = JSON.stringify({
      attachments: [{ name: 'photo.jpg', type: 'image', localPath: 'inbox/m1/photo.jpg' }],
    });
    expect(parseText(content)).toBe('[image: photo.jpg]');
  });

  it('joins multiple attachment placeholders', () => {
    const content = JSON.stringify({
      attachments: [
        { name: 'a.jpg', type: 'image' },
        { name: 'b.pdf', type: 'file' },
      ],
    });
    expect(parseText(content)).toBe('[image: a.jpg] [file: b.pdf]');
  });

  it('appends the caption after the bracket when present', () => {
    const content = JSON.stringify({
      attachments: [{ name: 'photo.jpg', type: 'image', localPath: 'inbox/m1/photo.jpg', caption: 'A red bicycle.' }],
    });
    expect(parseText(content)).toBe('[image: photo.jpg] A red bicycle.');
  });

  it('renders the failure message when captioning failed', () => {
    const content = JSON.stringify({
      attachments: [{ name: 'photo.jpg', type: 'image', captionError: 'connect ECONNREFUSED' }],
    });
    expect(parseText(content)).toBe('[image: photo.jpg] (no description available yet — try again shortly)');
  });

  it('falls back to the raw content when neither text nor attachments are present', () => {
    const content = JSON.stringify({ sender: 'user' });
    expect(parseText(content)).toBe(content);
  });

  it('returns unparseable content as-is', () => {
    expect(parseText('not json')).toBe('not json');
  });
});
