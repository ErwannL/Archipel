import { z } from 'zod';
import { ENTITY_KINDS, ModelError, type Extraction, type ModelProvider } from './provider.js';

export interface OpenAiOptions {
  baseUrl: string;
  apiKey: string;
  embedModel: string;
  chatModel: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const embeddingsSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});
const chatSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const ref = z.object({
  kind: z.enum(ENTITY_KINDS as [string, ...string[]]),
  name: z.string().min(1).max(120),
});
const extractionSchema = z.object({
  entities: z.array(ref).max(100),
  relations: z.array(z.object({ src: ref, dst: ref, type: z.string().min(1).max(40) })).max(100),
  stance: z.enum(['applies', 'contradicts', 'neutral']),
});

const SYSTEM_PROMPT = `You extract a knowledge graph from one passage of a project board.
Return JSON only: {"entities":[{"kind","name"}],"relations":[{"src":{"kind","name"},"dst":{"kind","name"},"type"}],"stance"}.
kind is one of: ${ENTITY_KINDS.join(', ')}. type is a short snake_case verb (depends_on, concerns, affects, uses, replaces...).
stance is "applies" if the passage follows a project guideline, "contradicts" if it goes against one, else "neutral".
Only use facts stated in the passage.`;

/** Any OpenAI-compatible endpoint (OpenAI, Azure-compatible gateways, Ollama, vLLM, Mistral...). */
export class OpenAiProvider implements ModelProvider {
  readonly id: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OpenAiOptions) {
    this.id = `openai:${opts.embedModel}`;
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ModelError('model_unreachable');
    }
    if (!res.ok) throw new ModelError(`model_http_${res.status}`);
    return res.json().catch(() => null);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const parsed = embeddingsSchema.safeParse(
      await this.post('/embeddings', { model: this.opts.embedModel, input: texts }),
    );
    if (!parsed.success || parsed.data.data.length !== texts.length) {
      throw new ModelError('model_bad_response');
    }
    return [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async extract(text: string): Promise<Extraction> {
    const chat = chatSchema.safeParse(
      await this.post('/chat/completions', {
        model: this.opts.chatModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    );
    if (!chat.success) throw new ModelError('model_bad_response');
    let json: unknown;
    try {
      json = JSON.parse(chat.data.choices[0]!.message.content);
    } catch {
      throw new ModelError('model_bad_response');
    }
    const out = extractionSchema.safeParse(json);
    if (!out.success) throw new ModelError('model_bad_response');
    return out.data as Extraction;
  }
}
