import type { ChatMessage, ChatMessageContent, ChatMessageContentPart } from '@star-cliproxy/shared';

// OpenAI messages 배열을 CLI 프롬프트 텍스트로 변환
export interface ConvertedPrompt {
  systemPrompt: string | null;
  userPrompt: string;
}

// 프롬프트 인젝션 방지: 사용자 입력에서 구분자 패턴을 이스케이프
// <|user|>, <|assistant|>, <|system|> 패턴을 유니코드 이스케이프 시퀀스로 치환
export function sanitizeDelimiters(content: string): string {
  return content
    .replace(/<\|user\|>/g, '<​user​>')
    .replace(/<\|assistant\|>/g, '<​assistant​>')
    .replace(/<\|system\|>/g, '<​system​>');
}

// 멀티모달 content part 중 이미지 블록 판별
// OpenAI Chat Completions: { type: 'image_url', image_url: { url } }
// OpenAI Responses API:   { type: 'input_image', image_url | image_url.url }
// Anthropic 호환:          { type: 'image', source: { ... } }
export function isImagePart(part: ChatMessageContentPart): boolean {
  const t = part?.type;
  return t === 'image_url' || t === 'input_image' || t === 'image';
}

// 멀티모달 content에서 텍스트만 추출 (CLI provider / 길이 검증용).
// 이미지 블록은 [image] 마커로 대체하여 위치 정보만 보존한다.
export function extractTextFromContent(content: ChatMessageContent | undefined | null): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (isImagePart(part)) {
      parts.push('[image]');
      continue;
    }
    if (typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

// chat-completions 라우트에서 content는 string 또는 multimodal parts 배열로 들어온다.
// CLI 프롬프트는 텍스트만 필요하므로 이미지 블록은 [image] 마커로 대체한다.
export function convertMessages(messages: ChatMessage[]): ConvertedPrompt {
  let systemPrompt: string | null = null;
  const conversationParts: string[] = [];

  for (const msg of messages) {
    const content = extractTextFromContent(msg.content);
    if (msg.role === 'system') {
      // 마지막 system 메시지를 사용
      systemPrompt = content;
    } else if (msg.role === 'user') {
      conversationParts.push(`<|user|> ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'assistant') {
      conversationParts.push(`<|assistant|> ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'tool') {
      // tool 결과를 user 메시지로 변환 (CLI 프로바이더는 tool role 미지원)
      const toolName = msg.name ?? 'tool';
      conversationParts.push(`<|user|> [Tool result ${sanitizeDelimiters(toolName)}] ${sanitizeDelimiters(content)}`);
    } else if (msg.role === 'developer') {
      // developer role은 system과 동일하게 처리
      systemPrompt = content;
    }
  }

  // 단일 user 메시지인 경우 태그 없이 원본 반환
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  if (nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'user') {
    return {
      systemPrompt,
      userPrompt: extractTextFromContent(nonSystemMessages[0].content),
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
