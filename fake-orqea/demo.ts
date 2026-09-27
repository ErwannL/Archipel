import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ArchipelClient, type OrqeaSecrets } from './client.js';
import { AGENT_FACTS, demoEvents, otherBoardEvents } from './board.js';

type Ev = { type: string; data: Record<string, unknown> };
interface Status {
  progress: number;
  totals: Record<string, number>;
  cards: { cardId: string; status: string }[];
}
interface QueryResult {
  passages: { itemKey: string; text: string }[];
  graph: { nodes: { name: string }[]; edges: unknown[] };
  guidelineLinks: { type: string; docId: string; section: string }[];
  citations: { itemKey: string }[];
  usedChars: number;
}

export interface DemoOptions extends OrqeaSecrets {
  boardId?: string;
  log?: (line: string) => void;
  open?: (url: string) => void;
  timeoutMs?: number;
}

export interface DemoReport {
  boardId: string;
  otherBoardId: string;
  status: Status;
  answer: QueryResult;
  leakCheck: QueryResult;
  deletion: { before: Record<string, number>; after: Record<string, number> };
  uiUrl: string;
}

async function push(client: ArchipelClient, boardId: string, events: Ev[]) {
  // Versions: Orqea's updatedAt in ms, strictly increasing per entity.
  const base = Date.now();
  const body = {
    events: events.map((e, i) => ({ eventId: randomUUID(), boardId, version: base + i, ...e })),
  };
  return client.call<{ results: { outcome: string }[] }>('POST', '/v1/events', body);
}

async function waitIndexed(
  client: ArchipelClient,
  boardId: string,
  timeoutMs: number,
): Promise<Status> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await client.call<Status>('GET', `/v1/boards/${boardId}/status`);
    if (s.progress === 1) return s;
    if (Date.now() > deadline) throw new Error(`indexing not finished after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Pushes the demo board end to end, like Orqea would, and returns what happened. */
export async function runDemo(
  opts: DemoOptions,
  client = new ArchipelClient(opts),
): Promise<DemoReport> {
  const log = opts.log ?? (() => undefined);
  const boardId = opts.boardId ?? `demo-${Date.now()}`;
  const otherBoardId = `${boardId}-autre`;
  const timeoutMs = opts.timeoutMs ?? 60000;

  log(
    `→ Board ${boardId} : ${demoEvents().length} événements (consignes, cartes, commentaires, comptes rendus, suppression)`,
  );
  await push(client, boardId, demoEvents());
  await push(client, otherBoardId, otherBoardEvents());
  const facts = await client.call('POST', `/v1/boards/${boardId}/facts`, {
    cardId: 'c-101',
    agentId: 'agent-dev',
    facts: AGENT_FACTS,
  });
  log(`→ Faits écrits par un agent : ${JSON.stringify(facts)}`);

  const status = await waitIndexed(client, boardId, timeoutMs);
  await waitIndexed(client, otherBoardId, timeoutMs);
  log(
    `→ Indexé : ${JSON.stringify(status.totals)} ; cartes : ${status.cards.map((c) => `${c.cardId}=${c.status}`).join(', ')}`,
  );

  const answer = await client.call<QueryResult>('POST', `/v1/boards/${boardId}/query`, {
    question: 'Comment doivent passer les paiements, et qui ne respecte pas la consigne ?',
    maxTokens: 1500,
  });
  log(
    `→ Requête agent : ${answer.passages.length} passages, ${answer.graph.nodes.length} entités, ${answer.usedChars} caractères`,
  );
  for (const l of answer.guidelineLinks)
    log(`   lien consigne : ${l.type} → ${l.docId} § ${l.section}`);
  log(`   citations : ${answer.citations.map((c) => c.itemKey).join(', ')}`);

  const leakCheck = await client.call<QueryResult>('POST', `/v1/boards/${boardId}/query`, {
    question: 'Zanzibar ornithorynque audit confidentiel',
  });
  const leaked = JSON.stringify(leakCheck).includes('ornithorynque');
  log(`→ Isolation : l'autre board ${leaked ? 'FUIT' : 'ne fuit pas'} dans ${boardId}`);

  const deletion = await client.call<{
    before: Record<string, number>;
    after: Record<string, number>;
  }>('DELETE', `/v1/boards/${otherBoardId}`);
  log(
    `→ Suppression du board ${otherBoardId} : avant ${JSON.stringify(deletion.before)} ; après ${JSON.stringify(deletion.after)}`,
  );

  const uiUrl = client.handoffUrl(boardId, 'u-alice');
  log(`→ UI (lien valable 60 s, usage unique) : ${uiUrl}`);
  opts.open?.(uiUrl);
  return { boardId, otherBoardId, status, answer, leakCheck, deletion, uiUrl };
}

/** Opens a URL with the desktop's default browser, if there is one. */
export function openInBrowser(url: string, platform = process.platform, run = spawn): void {
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  run(cmd, [url], { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
}

/** `npm run demo`: reads the same .env as docker compose. */
export async function runDemoCli(
  env: Record<string, string | undefined>,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<DemoReport> {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required (copy .env.example to .env)`);
    return v;
  };
  return runDemo({
    baseUrl: env.ARCHIPEL_URL ?? `http://127.0.0.1:${env.ARCHIPEL_PORT ?? '8080'}`,
    hmacSecret: need('ARCHIPEL_HMAC_SECRET'),
    handoffSecret: need('ARCHIPEL_HANDOFF_SECRET'),
    log: out,
    ...(env.DEMO_OPEN === '0'
      ? {}
      : {
          open: (u: string) => {
            openInBrowser(u);
          },
        }),
  });
}
