import { z } from 'zod';

const secret = z.string().min(32);

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    ARCHIPEL_HMAC_SECRET: secret,
    ARCHIPEL_HANDOFF_SECRET: secret,
    ARCHIPEL_SESSION_SECRET: secret,
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
    // Public link back to Orqea (header, credits, 404 page): the Orqea of THIS environment.
    ARCHIPEL_ORQEA_URL: z.string().url().default('https://orqea.dev'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
    AI_PROVIDER: z.enum(['fake', 'openai']).default('fake'),
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    OPENAI_API_KEY: z.string().default(''),
    OPENAI_EMBED_MODEL: z.string().min(1).default('text-embedding-3-small'),
    OPENAI_CHAT_MODEL: z.string().min(1).default('gpt-4o-mini'),
    MAX_EVENT_BYTES: z.coerce.number().int().min(1024).default(262144),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
    SIGNATURE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(300),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(1800),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    WORKER_POLL_MS: z.coerce.number().int().min(10).default(500),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
    JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(2000),
  })
  .refine((c) => c.ARCHIPEL_HMAC_SECRET !== c.ARCHIPEL_HANDOFF_SECRET, {
    message: 'ARCHIPEL_HANDOFF_SECRET must differ from ARCHIPEL_HMAC_SECRET',
  })
  .refine((c) => c.AI_PROVIDER === 'fake' || c.OPENAI_API_KEY !== '', {
    message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai',
  });

export type Config = z.infer<typeof schema>;

/** Parses the environment. Error messages name variables only, never their values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid configuration: ${issues.join('; ')}`);
  }
  return parsed.data;
}
