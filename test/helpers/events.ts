import { randomUUID } from 'node:crypto';
import { eventSchema, toOperation, type OrqeaEvent } from '../../src/ingest/events.js';

export function event(boardId: string, type: string, version: number, data: object): OrqeaEvent {
  return eventSchema.parse({ eventId: randomUUID(), boardId, type, version, data });
}

export const op = (boardId: string, type: string, version: number, data: object) =>
  toOperation(event(boardId, type, version, data));
