type Child = Node | string;

/** Builds an element. Text is always set as text (never parsed as HTML). */
export function el(
  doc: Document,
  tag: string,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElement {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function clear(node: Element, ...children: Child[]): void {
  node.replaceChildren(...children);
}
