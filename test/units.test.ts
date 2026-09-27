import { describe, expect, it } from 'vitest';
import { eventSchema, toOperation } from '../src/ingest/events.js';
import { chunkMarkdown } from '../src/processing/chunk.js';
import { pack } from '../src/query/budget.js';
import { aggregate } from '../src/query/status.js';

describe('chunkMarkdown', () => {
  it('splits by heading and by size on paragraph boundaries', () => {
    const body = [
      'intro',
      '# A',
      'para 1',
      '',
      'para 2',
      '## B',
      'x'.repeat(25),
      '',
      'y'.repeat(5),
    ].join('\n');
    expect(chunkMarkdown('Doc', body, 20)).toEqual([
      { heading: 'Doc', text: 'intro' },
      { heading: 'A', text: 'para 1\n\npara 2' },
      { heading: 'B', text: 'x'.repeat(20) },
      { heading: 'B', text: 'x'.repeat(5) + '\n\n' + 'y'.repeat(5) },
    ]);
  });
  it('falls back to the title and handles empty input', () => {
    expect(chunkMarkdown('Titre seul', '')).toEqual([{ heading: '', text: 'Titre seul' }]);
    expect(chunkMarkdown(' ', '')).toEqual([]);
  });
});

describe('events → operations', () => {
  const base = { eventId: 'e', boardId: 'b', version: 3 };
  const op = (type: string, data: object) =>
    toOperation(eventSchema.parse({ ...base, type, data }));
  it('maps every event type', () => {
    expect(
      op('card.moved', {
        cardId: 'c',
        title: 'T',
        description: 'D',
        listName: 'Done',
        labels: ['x', 'y'],
        authorId: 'u',
      }),
    ).toEqual({
      op: 'upsert',
      boardId: 'b',
      version: 3,
      item: {
        key: 'card:c',
        kind: 'card',
        cardId: 'c',
        docId: null,
        authorId: 'u',
        authorName: null,
        title: 'T',
        body: 'D\n\nListe : Done · Étiquettes : x, y',
      },
    });
    expect(op('card.created', { cardId: 'c', title: 'T' })).toMatchObject({ item: { body: '' } });
    expect(op('card.updated', { cardId: 'c', title: 'T', labels: ['l'] })).toMatchObject({
      item: { body: 'Étiquettes : l' },
    });
    expect(op('card.deleted', { cardId: 'c' })).toEqual({
      op: 'delete',
      boardId: 'b',
      version: 3,
      key: 'card:c',
      cardId: 'c',
    });
    expect(op('comment.updated', { commentId: 'm', cardId: 'c', text: 'hi' })).toMatchObject({
      item: { key: 'comment:m', body: 'hi', cardId: 'c' },
    });
    expect(op('comment.deleted', { commentId: 'm', cardId: 'c' })).toMatchObject({
      key: 'comment:m',
      cardId: null,
    });
    expect(
      op('checklist.updated', {
        checklistId: 'k',
        cardId: 'c',
        title: 'L',
        items: [
          { text: 'a', done: true },
          { text: 'b', done: false },
        ],
      }),
    ).toMatchObject({
      item: { key: 'checklist:k', title: 'L', body: '- [x] a\n- [ ] b' },
    });
    expect(op('checklist.deleted', { checklistId: 'k', cardId: 'c' })).toMatchObject({
      key: 'checklist:k',
    });
    expect(
      op('report.created', { reportId: 'r', cardId: 'c', text: 'R', agentId: 'a' }),
    ).toMatchObject({ item: { key: 'report:r', kind: 'report' } });
    expect(op('report.deleted', { reportId: 'r', cardId: 'c' })).toMatchObject({ key: 'report:r' });
    expect(op('doc.updated', { docId: 'd', title: 'T', markdown: '# x' })).toMatchObject({
      item: { key: 'doc:d', docId: 'd', cardId: null },
    });
    expect(op('doc.deleted', { docId: 'd' })).toMatchObject({ key: 'doc:d' });
    expect(op('board.deleted', {})).toEqual({ op: 'deleteBoard', boardId: 'b', version: 3 });
    expect(eventSchema.safeParse({ ...base, type: 'card.exploded', data: {} }).success).toBe(false);
  });
});

describe('budget packing', () => {
  it('keeps what fits, shrinks the first overflow, reports truncation', () => {
    expect(pack(['aa', 'bb'], 100)).toEqual({ kept: ['aa', 'bb'], used: 10, truncated: false });
    expect(pack(['aaaa', 'bbbb'], 8)).toEqual({ kept: ['aaaa'], used: 7, truncated: true });
    expect(pack(['aaaa', 'bbbbbbb'], 12, (s, room) => s.slice(0, room - 3))).toEqual({
      kept: ['aaaa', 'b'],
      used: 11,
      truncated: true,
    });
    expect(pack(['aaaa', 'bbbb'], 8, () => null)).toEqual({
      kept: ['aaaa'],
      used: 7,
      truncated: true,
    });
  });
});

describe('card status aggregation', () => {
  it('takes the worst status', () => {
    expect(aggregate(['indexed', 'failed', 'pending'])).toBe('failed');
    expect(aggregate(['indexed', 'processing'])).toBe('processing');
    expect(aggregate(['indexed', 'pending'])).toBe('pending');
    expect(aggregate(['indexed'])).toBe('indexed');
  });
});
