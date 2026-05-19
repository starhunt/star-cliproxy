// OpenAI-compatible API 타입 정의

// OpenAI content parts 형식 (multimodal / LangChain / LiteLLM 등에서 사용)
export interface ChatMessageContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type ChatMessageContent = string | ChatMessageContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool';
  content: ChatMessageContent;
  name?: string;            // tool role: 함수/도구 이름
  tool_call_id?: string;    // tool role: 연관된 tool_call ID
  // assistant 응답에만 사용: 추론 모델의 thinking/CoT 본문. content와 분리되어 보존됨.
  // OpenAI 공식 스펙 외 비표준 확장 (vLLM/sglang/OpenRouter 등과 호환).
  reasoning_content?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  // OpenAI 호환 추론 수준. 지정 시 model_mapping의 값보다 우선.
  reasoning_effort?: string;
  // 추론 본문(thinking)을 응답에 포함할지. 우선순위: body > mapping > 전역 default(false).
  include_reasoning?: boolean;
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
export interface ChatCompletionChunkToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
  // 추론 본문 delta. vLLM/sglang reasoning_parser 호환 비표준 확장.
  reasoning_content?: string;
  tool_calls?: ChatCompletionChunkToolCall[];
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

// OpenAI Images API 호환 타입
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
}

export interface ImageGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

// OpenAI Embeddings API 호환 타입
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

export interface EmbeddingObject {
  object: 'embedding';
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// Rerank API 호환 타입 (Cohere Rerank API 스타일)
export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
}

export interface RerankResponseItem {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

export interface RerankResponse {
  id: string;
  results: RerankResponseItem[];
  model: string;
  usage: {
    total_tokens: number;
  };
}

// OpenAI Audio Speech (TTS) API 호환 타입
export type TtsResponseFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface TtsRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: TtsResponseFormat;
  speed?: number;
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
