import { describe, expect, it } from 'vitest';
import {
  FAKE_DIMENSIONS,
  FakeProvider,
  fakeEmbedding,
  fakeExtract,
  tokens,
} from '../src/ai/fake.js';
import { createProvider } from '../src/ai/index.js';
import { OpenAiProvider } from '../src/ai/openai.js';
import { ModelError, normalizeName } from '../src/ai/provider.js';
import { loadConfig } from '../src/config.js';
import { TEST_ENV } from './helpers/env.js';

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe('fake provider', () => {
  it('is deterministic, normalised and semantically sensible', async () => {
    const p = new FakeProvider();
    const [a, b, c] = await p.embed(['paiement par carte', 'paiements carte', 'réunion du lundi']);
    expect(a).toHaveLength(FAKE_DIMENSIONS);
    expect(cos(a!, a!)).toBeCloseTo(1);
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
    expect(fakeEmbedding('paiement par carte')).toEqual(a);
    expect(fakeEmbedding('le la')[0]).toBe(1);
    expect(tokens('Le Module Paiement')).toEqual(['module', 'paiement']);
  });

  it('extracts people, components, concepts, decisions, bugs and relations', async () => {
    const text = [
      'Voir avec @alice et @bob.',
      'Le service Auth dépend de `Redis`. Le module Cache remplace Memcached. Front utilise Api.',
      'Décidé : migrer vers `Redis` #perf',
      'Bug : timeout sur Auth',
      '# Titre de section',
    ].join('\n');
    const ex = await new FakeProvider().extract(text);
    const names = ex.entities.map((e) => `${e.kind}:${e.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'person:alice',
        'person:bob',
        'component:Auth',
        'component:Redis',
        'component:Cache',
        'component:Memcached',
        'component:Front',
        'component:Api',
        'decision:migrer vers `Redis` #perf',
        'bug:timeout sur Auth',
        'concept:perf',
      ]),
    );
    expect(names.some((n) => n.startsWith('concept:Titre'))).toBe(false);
    const rels = ex.relations.map((r) => `${r.src.name} ${r.type} ${r.dst.name}`);
    expect(rels).toEqual(
      expect.arrayContaining([
        'Auth depends_on Redis',
        'Cache replaces Memcached',
        'Front uses Api',
        'timeout sur Auth affects Redis',
      ]),
    );
    expect(rels.some((r) => r.startsWith('migrer') && r.includes('concerns'))).toBe(true);
    expect(ex.stance).toBe('neutral');
  });

  it('detects stance toward guidelines', () => {
    expect(fakeExtract('Contrairement à la consigne, on a supprimé la table.').stance).toBe(
      'contradicts',
    );
    expect(fakeExtract('Conformément à la consigne, tout passe par la gateway.').stance).toBe(
      'applies',
    );
  });

  it('normalises names', () => {
    expect(normalizeName('  Élan  `Vital` ')).toBe('elan vital');
    expect(new ModelError('x').name).toBe('ModelError');
  });
});

type Call = { url: string; body: Record<string, unknown>; auth: string };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(init.body as string),
      auth: (init.headers as Record<string, string>).authorization!,
    });
    const next = responses.shift()!;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const opts = {
  baseUrl: 'http://model.local/v1/',
  apiKey: 'sk',
  embedModel: 'emb',
  chatModel: 'chat',
};

describe('OpenAI-compatible provider', () => {
  it('embeds in input order', async () => {
    const { fn, calls } = fakeFetch([
      json({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    ]);
    const p = new OpenAiProvider({ ...opts, fetch: fn });
    expect(p.id).toBe('openai:emb');
    expect(await p.embed(['a', 'b'])).toEqual([[1], [2]]);
    expect(calls[0]).toMatchObject({
      url: 'http://model.local/v1/embeddings',
      auth: 'Bearer sk',
      body: { model: 'emb', input: ['a', 'b'] },
    });
  });

  it('extracts through chat completions with validated JSON', async () => {
    const extraction = {
      entities: [{ kind: 'component', name: 'A' }],
      relations: [],
      stance: 'neutral',
    };
    const { fn, calls } = fakeFetch([
      json({ choices: [{ message: { content: JSON.stringify(extraction) } }] }),
    ]);
    expect(await new OpenAiProvider({ ...opts, fetch: fn }).extract('t')).toEqual(extraction);
    expect(calls[0]!.body.model).toBe('chat');
  });

  it('maps every failure to a content-free ModelError code', async () => {
    const chat = (content: string) => json({ choices: [{ message: { content } }] });
    const cases: [Response | Error, 'embed' | 'extract', string][] = [
      [new Error('ECONNREFUSED secret text'), 'embed', 'model_unreachable'],
      [json({}, 503), 'embed', 'model_http_503'],
      [new Response('not json'), 'embed', 'model_bad_response'],
      [json({ data: [] }), 'embed', 'model_bad_response'],
      [json({ choices: [] }), 'extract', 'model_bad_response'],
      [chat('not json'), 'extract', 'model_bad_response'],
      [chat('{"entities":"x"}'), 'extract', 'model_bad_response'],
    ];
    for (const [res, method, code] of cases) {
      const p = new OpenAiProvider({ ...opts, fetch: fakeFetch([res]).fn, timeoutMs: 1000 });
      await expect(method === 'embed' ? p.embed(['a']) : p.extract('a')).rejects.toThrow(
        new ModelError(code),
      );
    }
  });

  it('defaults to the global fetch', () => {
    expect(new OpenAiProvider(opts).id).toBe('openai:emb');
  });
});

describe('provider factory', () => {
  it('selects fake by default and openai when configured', () => {
    expect(createProvider(loadConfig(TEST_ENV)).id).toBe('fake:v1');
    expect(
      createProvider(loadConfig({ ...TEST_ENV, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })).id,
    ).toBe('openai:text-embedding-3-small');
  });
});
