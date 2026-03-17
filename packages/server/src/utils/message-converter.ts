import type { ChatMessage } from '@star-cliproxy/shared';

// OpenAI messages 배열을 CLI 프롬프트 텍스트로 변환
export interface ConvertedPrompt {
  systemPrompt: string | null;
  userPrompt: string;
}

// 프롬프트 인젝션 방지: 사용자 입력에서 구분자 패턴을 이스케이프
// <|user|>, <|assistant|>, <|system|> 패턴을 유니코드 이스케이프 시퀀스로 치환
export function sanitizeDelimiters(content: string): string {
  return content
    .replace(/<\|user\|>/g, '<\u200Buser\u200B>')
    .replace(/<\|assistant\|>/g, '<\u200Bassistant\u200B>')
    .replace(/<\|system\|>/g, '<\u200Bsystem\u200B>');
}

export function convertMessages(messages: ChatMessage[]): ConvertedPrompt {
  let systemPrompt: string | null = null;
  const conversationParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // 마지막 system 메시지를 사용
      systemPrompt = msg.content;
    } else if (msg.role === 'user') {
      conversationParts.push(`<|user|> ${sanitizeDelimiters(msg.content)}`);
    } else if (msg.role === 'assistant') {
      conversationParts.push(`<|assistant|> ${sanitizeDelimiters(msg.content)}`);
    }
  }

  // 단일 user 메시지인 경우 태그 없이 원본 반환
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  if (nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user') {
    return {
      systemPrompt,
      userPrompt: nonSystemMessages[0].content,
    };
  }

  return {
    systemPrompt,
    userPrompt: conversationParts.join('\n\n'),
  };
}

// system prompt를 포함한 단일 프롬프트 생성 (Codex/Gemini용)
export function convertMessagesToSinglePrompt(messages: ChatMessage[]): string {
  const { systemPrompt, userPrompt } = convertMessages(messages);

  if (systemPrompt) {
    return `<|system|> ${systemPrompt}\n\n${userPrompt}`;
  }

  return userPrompt;
}
