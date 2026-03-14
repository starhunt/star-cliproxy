import type { ChatMessage } from '@star-cliproxy/shared';

// OpenAI messages 배열을 CLI 프롬프트 텍스트로 변환
export interface ConvertedPrompt {
  systemPrompt: string | null;
  userPrompt: string;
}

export function convertMessages(messages: ChatMessage[]): ConvertedPrompt {
  let systemPrompt: string | null = null;
  const conversationParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // 마지막 system 메시지를 사용
      systemPrompt = msg.content;
    } else if (msg.role === 'user') {
      conversationParts.push(`[User] ${msg.content}`);
    } else if (msg.role === 'assistant') {
      conversationParts.push(`[Assistant] ${msg.content}`);
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
    return `[System] ${systemPrompt}\n\n${userPrompt}`;
  }

  return userPrompt;
}
