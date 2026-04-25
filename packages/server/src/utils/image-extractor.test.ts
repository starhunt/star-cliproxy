import { describe, it, expect, afterEach } from 'vitest';
import { readFile, stat, unlink } from 'node:fs/promises';
import type { ChatMessage } from '@star-cliproxy/shared';
import { prepareGeminiPrompt } from './image-extractor.js';

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('prepareGeminiPrompt', () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    while (tmpFiles.length) {
      const f = tmpFiles.pop()!;
      await unlink(f).catch(() => undefined);
    }
  });

  it('이미지 없는 메시지는 그대로 텍스트 프롬프트로 직렬화', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ];
    const result = await prepareGeminiPrompt(messages);
    expect(result.hasImages).toBe(false);
    expect(result.tempFiles).toHaveLength(0);
    expect(result.prompt).toContain('<|system|> You are helpful.');
    expect(result.prompt).toContain('hello');
  });

  it('OpenAI image_url + base64 data URL → 임시 파일 + @<path> 토큰', async () => {
    const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];

    const result = await prepareGeminiPrompt(messages);
    tmpFiles.push(...result.tempFiles);

    expect(result.hasImages).toBe(true);
    expect(result.tempFiles).toHaveLength(1);
    expect(result.failures).toHaveLength(0);

    const filePath = result.tempFiles[0];
    expect(filePath).toMatch(/cliproxy-img-[a-f0-9]+\.png$/);
    expect(result.prompt).toContain('describe');
    expect(result.prompt).toContain(`@${filePath}`);
    expect(result.prompt).not.toContain('base64,');

    // 실제 파일 내용 = 디코드된 PNG 바이트
    const written = await readFile(filePath);
    expect(written.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);

    const meta = await stat(filePath);
    expect(meta.size).toBe(Buffer.from(PNG_BASE64, 'base64').length);
  });

  it('Anthropic image source(base64) 형식도 수용', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'analyze' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: PNG_BASE64 },
          },
        ],
      },
    ];

    const result = await prepareGeminiPrompt(messages);
    tmpFiles.push(...result.tempFiles);

    expect(result.hasImages).toBe(true);
    expect(result.tempFiles[0]).toMatch(/\.jpg$/);
  });

  it('내부 IP(SSRF) URL은 거부되어 [image (skipped: ...)] 마커로 폴백', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'fetch this' },
          { type: 'image_url', image_url: { url: 'http://127.0.0.1:9999/secret.png' } },
        ],
      },
    ];

    const result = await prepareGeminiPrompt(messages);
    tmpFiles.push(...result.tempFiles);

    expect(result.hasImages).toBe(false);
    expect(result.tempFiles).toHaveLength(0);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.join(' ')).toMatch(/private|internal/i);
    expect(result.prompt).toContain('[image (skipped:');
  });

  it('잘못된 image part는 [image (skipped)] 마커로 폴백', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x' },
          { type: 'image_url' }, // url 없음
        ],
      },
    ];

    const result = await prepareGeminiPrompt(messages);
    expect(result.hasImages).toBe(false);
    expect(result.failures).toContain('image part missing url/data');
  });
});
