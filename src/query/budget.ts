/** Size in characters of a value once serialised, as the agent will receive it. */
export const sizeOf = (v: unknown): number => JSON.stringify(v).length;

/**
 * Packs items into a character budget, in order. The first item that does not
 * fit may be shortened by `shrink` (if given); everything after it is dropped.
 */
export function pack<T>(
  items: T[],
  budget: number,
  shrink?: (item: T, room: number) => T | null,
): { kept: T[]; used: number; truncated: boolean } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item) + 1;
    if (used + size <= budget) {
      kept.push(item);
      used += size;
      continue;
    }
    const smaller = shrink?.(item, budget - used - 1) ?? null;
    if (smaller !== null) {
      kept.push(smaller);
      used += sizeOf(smaller) + 1;
    }
    return { kept, used, truncated: true };
  }
  return { kept, used, truncated: false };
}
