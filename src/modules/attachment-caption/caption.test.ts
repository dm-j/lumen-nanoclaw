import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: () => ({
      jpeg: () => ({
        toBuffer: async () => Buffer.from('fake-jpeg-bytes'),
      }),
    }),
  })),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { captionImage, stampCaptionIds } from './caption.js';

function mockFetchOnce(response: { ok: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      json: response.json ?? (async () => ({})),
    }),
  );
}

describe('stampCaptionIds', () => {
  it('returns content unchanged when there are no attachments', () => {
    const content = JSON.stringify({ text: 'hello' });
    expect(stampCaptionIds(content)).toBe(content);
  });

  it('skips non-image attachments', () => {
    const content = JSON.stringify({ attachments: [{ type: 'file', name: 'doc.pdf' }] });
    expect(stampCaptionIds(content)).toBe(content);
  });

  it('assigns a captionId derived from the filename to an image attachment', () => {
    const content = JSON.stringify({ attachments: [{ type: 'image', name: 'photo.jpg' }] });
    const result = JSON.parse(stampCaptionIds(content));
    expect(result.attachments[0].captionId).toMatch(/^photo-[0-9a-f]{4}$/);
  });

  it('leaves an already-stamped attachment alone (idempotent across re-routing)', () => {
    const content = JSON.stringify({ attachments: [{ type: 'image', name: 'photo.jpg', captionId: 'photo-abcd' }] });
    expect(stampCaptionIds(content)).toBe(content);
  });
});

describe('captionImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the caption on success', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ response: '  A red bicycle leaning against a wall.  ' }) });
    const result = await captionImage('YmFzZTY0');
    expect(result).toEqual({ ok: true, text: 'A red bicycle leaning against a wall.' });
  });

  it('fails on a non-2xx Ollama response', async () => {
    mockFetchOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
    const result = await captionImage('YmFzZTY0');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('500');
  });

  it('fails when the request throws (daemon unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434')));
    const result = await captionImage('YmFzZTY0');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('ECONNREFUSED');
  });

  it('fails on an empty Ollama response', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ response: '   ' }) });
    const result = await captionImage('YmFzZTY0');
    expect(result).toEqual({ ok: false, text: 'Ollama returned an empty response' });
  });

  it('folds a user-supplied caption into the prompt as context, without dropping the base instructions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ response: 'A dragon.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await captionImage('YmFzZTY0', 'Kirily the Dragon eating at a diner');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt).toContain('legally blind');
    expect(body.prompt).toContain('Kirily the Dragon eating at a diner');
    expect(body.prompt).toContain('do not simply restate the caption');
  });

  it('omits the caption-context instructions entirely when no user caption is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ response: 'A dragon.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await captionImage('YmFzZTY0');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt).not.toContain('captioned this image');
  });
});
