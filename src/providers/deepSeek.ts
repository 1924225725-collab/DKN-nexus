import type { ChatMessage } from "../domain";
import type { LLMProvider, LLMResponse } from "./types";

export class DeepSeekProvider implements LLMProvider {
  readonly id = "deepseek";
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly model: string) {}
  async complete(prompt: string): Promise<string> { const result = await this.chat([{ role: "user", content: prompt }]); return result.content; }
  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify({ model: this.model, messages, stream: false }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `DeepSeek 请求失败（${response.status}）`);
    return { content: payload?.choices?.[0]?.message?.content ?? "", usage: { promptTokens: payload?.usage?.prompt_tokens, completionTokens: payload?.usage?.completion_tokens } };
  }
}
