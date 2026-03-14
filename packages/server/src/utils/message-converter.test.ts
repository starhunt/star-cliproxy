import { describe, it, expect } from 'vitest';
import { convertMessages, convertMessagesToSinglePrompt } from './message-converter.js';
import type { ChatMessage } from '@star-cliproxy/shared';

describe('convertMessages', () => {
  it('단일 user 메시지는 태그 없이 반환', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
    ];

    const result = convertMessages(messages);
    expect(result.systemPrompt).toBeNull();
    expect(result.userPrompt).toBe('Hello');
  });

  it('system 메시지를 분리', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = convertMessages(messages);
    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.userPrompt).toBe('Hello');
  });

  it('멀티턴 대화를 태그 형식으로 변환', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'What is 2+2?' },
    ];

    const result = convertMessages(messages);
    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.userPrompt).toContain('[User] Hello');
    expect(result.userPrompt).toContain('[Assistant] Hi!');
    expect(result.userPrompt).toContain('[User] What is 2+2?');
  });
});

describe('convertMessagesToSinglePrompt', () => {
  it('system 포함 시 [System] 태그 추가', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ];

    const result = convertMessagesToSinglePrompt(messages);
    expect(result).toContain('[System] Be concise.');
    expect(result).toContain('Hello');
  });

  it('system 없으면 태그 없이 반환', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
    ];

    const result = convertMessagesToSinglePrompt(messages);
    expect(result).toBe('Hello');
    expect(result).not.toContain('[System]');
  });
});
