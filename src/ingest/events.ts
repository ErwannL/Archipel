import { z } from 'zod';

export const id = z.string().min(1).max(128);
const name = z.string().max(200).optional();
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { eventId: id, boardId: id, version };
const author = { authorId: id.optional(), authorName: name };

const cardData = z.object({
  cardId: id,
  title: z.string().max(1000),
  description: z.string().max(100000).default(''),
  listName: z.string().max(500).optional(),
  labels: z.array(z.string().max(100)).max(50).default([]),
  ...author,
});
const commentData = z.object({
  commentId: id,
  cardId: id,
  text: z.string().max(100000),
  ...author,
});
const checklistData = z.object({
  checklistId: id,
  cardId: id,
  title: z.string().max(1000),
  items: z.array(z.object({ text: z.string().max(2000), done: z.boolean() })).max(500),
  ...author,
});
const reportData = z.object({
  reportId: id,
  cardId: id,
  text: z.string().max(200000),
  agentId: id.optional(),
  ...author,
});
const docData = z.object({
  docId: id,
  title: z.string().max(1000),
  markdown: z.string().max(200000),
  ...author,
});

const ev = <T extends string, D extends z.ZodTypeAny>(types: [T, ...T[]], data: D) =>
  z.object({ ...base, type: z.enum(types), data });

export const eventSchema = z.discriminatedUnion('type', [
  ev(['card.created', 'card.updated', 'card.moved'], cardData),
  ev(['card.deleted'], z.object({ cardId: id })),
  ev(['comment.created', 'comment.updated'], commentData),
  ev(['comment.deleted'], z.object({ commentId: id, cardId: id })),
  ev(['checklist.created', 'checklist.updated'], checklistData),
  ev(['checklist.deleted'], z.object({ checklistId: id, cardId: id })),
  ev(['report.created', 'report.updated'], reportData),
  ev(['report.deleted'], z.object({ reportId: id, cardId: id })),
  ev(['doc.created', 'doc.updated'], docData),
  ev(['doc.deleted'], z.object({ docId: id })),
  ev(['board.deleted'], z.object({}).default({})),
]);

export type OrqeaEvent = z.infer<typeof eventSchema>;

export type ItemKind = 'card' | 'comment' | 'checklist' | 'report' | 'doc' | 'fact';

export interface ItemInput {
  key: string;
  kind: ItemKind;
  cardId: string | null;
  docId: string | null;
  authorId: string | null;
  authorName: string | null;
  title: string;
  body: string;
}

/** Normalised operation: every event becomes exactly one of these. */
export type Operation =
  | { op: 'upsert'; boardId: string; version: number; item: ItemInput }
  | { op: 'delete'; boardId: string; version: number; key: string; cardId: string | null }
  | { op: 'deleteBoard'; boardId: string; version: number };

type Data = Record<string, unknown>;
const s = (d: Data, k: string): string => d[k] as string;
const opt = (d: Data, k: string): string | null => (d[k] as string | undefined) ?? null;

function item(kind: ItemKind, key: string, d: Data, title: string, body: string): ItemInput {
  return {
    key,
    kind,
    cardId: opt(d, 'cardId'),
    docId: opt(d, 'docId'),
    authorId: opt(d, 'authorId'),
    authorName: opt(d, 'authorName'),
    title,
    body,
  };
}

function cardBody(d: Data): string {
  const labels = d.labels as string[];
  const meta = [
    d.listName ? `Liste : ${s(d, 'listName')}` : '',
    labels.length ? `Étiquettes : ${labels.join(', ')}` : '',
  ].filter(Boolean);
  return [s(d, 'description'), meta.join(' · ')].filter(Boolean).join('\n\n');
}

export function toOperation(e: OrqeaEvent): Operation {
  const { boardId, version } = e;
  const d = e.data as Data;
  const [entity, action] = e.type.split('.') as [string, string];
  if (entity === 'board') return { op: 'deleteBoard', boardId, version };
  const keyId = s(d, entity === 'doc' ? 'docId' : `${entity}Id`);
  const key = `${entity}:${keyId}`;
  if (action === 'deleted') {
    return { op: 'delete', boardId, version, key, cardId: entity === 'card' ? keyId : null };
  }
  const build: Record<string, () => ItemInput> = {
    card: () => item('card', key, d, s(d, 'title'), cardBody(d)),
    comment: () => item('comment', key, d, '', s(d, 'text')),
    checklist: () =>
      item(
        'checklist',
        key,
        d,
        s(d, 'title'),
        (d.items as { text: string; done: boolean }[])
          .map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`)
          .join('\n'),
      ),
    report: () => item('report', key, d, '', s(d, 'text')),
    doc: () => item('doc', key, d, s(d, 'title'), s(d, 'markdown')),
  };
  return { op: 'upsert', boardId, version, item: build[entity]!() };
}
