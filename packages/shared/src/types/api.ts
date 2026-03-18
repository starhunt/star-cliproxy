// OpenAI-compatible API 타입 정의

// OpenAI content parts 형식 (multimodal / LangChain / LiteLLM 등에서 사용)
export interface ChatMessageContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: UsageInfo;
}

// SSE 스트리밍 타입
export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

// 모델 목록 응답
export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: 'list';
  data: ModelObject[];
}

// 에러 응답
export interface ApiErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}
