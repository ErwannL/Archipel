export interface Chunk {
  heading: string;
  text: string;
}

function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n\s*\n/)) {
    for (let i = 0; i < para.length; i += max) {
      const part = para.slice(i, i + max).trim();
      if (cur && cur.length + part.length + 2 > max) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${part}` : part;
    }
  }
  return cur ? [...out, cur] : out;
}

/**
 * Splits Markdown into passages: one section per heading, sections longer than
 * `max` characters split on paragraph boundaries. The item title is the heading
 * of text before the first Markdown heading.
 */
export function chunkMarkdown(title: string, body: string, max = 900): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = title.trim();
  let buf: string[] = [];
  const flush = () => {
    for (const text of pieces(buf.join('\n').trim(), max)) chunks.push({ heading, text });
    buf = [];
  };
  for (const line of body.split('\n')) {
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      flush();
      heading = h[1]!.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  if (chunks.length === 0 && title.trim()) chunks.push({ heading: '', text: title.trim() });
  return chunks;
}
