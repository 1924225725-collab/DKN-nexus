import type { ChatMessage } from "../domain";

export interface ProviderUsage { promptTokens?: number; completionTokens?: number; }

export interface LLMResponse { content: string; usage?: ProviderUsage; }

export interface LLMProvider {
  readonly id: string;
  complete(prompt: string): Promise<string>;
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse>;
}

export interface SpeechProvider {
  readonly id: string;
  transcribe(audio: Blob): Promise<string>;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, signal?: AbortSignal): Promise<ReadonlyArray<{ title: string; url: string; content?: string; publishedAt?: string }>>;
}
