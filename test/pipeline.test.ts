import { afterAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { FakeProvider } from '../src/ai/fake.js';
import { ModelError, type ModelProvider } from '../src/ai/provider.js';
import { applyOperation } from '../src/ingest/apply.js';
import { processItem } from '../src/processing/pipeline.js';
import { Worker } from '../src/processing/worker.js';
import { query } from '../src/query/query.js';
import { boardStatus } from '../src/query/status.js';
import { islandCounts, withIsland } from '../src/store/islands.js';
import { newBoardId, testPool } from './helpers/db.js';
import { op } from './helpers/events.js';

const pool = testPool();
afterAll(() => pool.end());
const fake = new FakeProvider();
const log = pino({ level: 'silent' });
const worker = (provider: ModelProvider = fake) =>
  new Worker(pool, provider, log, { pollMs: 10, maxAttempts: 3, backoffBaseMs: 1 });

describe('ingest → process → query', () => {
  it('builds a graph with guideline links and answers with citations', async () => {
    const b = newBoardId();
    await applyOperation(
      pool,
      op(b, 'doc.created', 1, {
        docId: 'd1',
        title: 'Consignes',
        authorId: 'u1',
        authorName: 'Alice',
        markdown: '# Paiements\nToujours passer par le module `PaymentGateway` pour les paiements.',
      }),
    );
    await applyOperation(
      pool,
      op(b, 'card.created', 1, {
        cardId: 'c1',
        title: 'Refonte checkout',
        description: 'Le `Checkout` dépend de `PaymentGateway`.',
        listName: 'En cours',
        labels: ['backend'],
        authorId: 'u2',
        authorName: 'Bob',
      }),
    );
    await applyOperation(
      pool,
      op(b, 'report.created', 2, {
        reportId: 'r1',
        cardId: 'c1',
        agentId: 'agent-1',
        authorId: 'u2',
        text: 'Décidé : garder `PaymentGateway`.\nConformément à la consigne, les paiements passent par le module `PaymentGateway`.',
      }),
    );
    expect((await boardStatus(pool, b)).totals.pending).toBe(3);
    expect(await worker().drain()).toBe(3);
    const st = await boardStatus(pool, b);
    expect(st.progress).toBe(1);
    expect(st.cards).toEqual([{ cardId: 'c1', status: 'indexed', items: 2 }]);

    const res = await query(pool, fake, b, {
      question: 'Comment passent les paiements ?',
      maxChars: 6000,
      topK: 5,
    });
    expect(res.passages.length).toBeGreaterThan(0);
    expect(res.citations.map((c) => c.itemKey)).toContain('doc:d1');
    expect(res.graph.nodes.map((n) => n.name)).toContain('PaymentGateway');
    expect(res.guidelineLinks.some((l) => l.type === 'applies' && l.docId === 'd1')).toBe(true);
    expect(res.usedChars).toBeLessThanOrEqual(6000);
  });
});
