import type { Config } from '../config.js';
import { FakeProvider } from './fake.js';
import { OpenAiProvider } from './openai.js';
import type { ModelProvider } from './provider.js';

export function createProvider(config: Config): ModelProvider {
  if (config.AI_PROVIDER === 'openai') {
    return new OpenAiProvider({
      baseUrl: config.OPENAI_BASE_URL,
      apiKey: config.OPENAI_API_KEY,
      embedModel: config.OPENAI_EMBED_MODEL,
      chatModel: config.OPENAI_CHAT_MODEL,
    });
  }
  return new FakeProvider();
}
