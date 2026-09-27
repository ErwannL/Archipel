// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const handlers: Record<string, (e: unknown) => void> = {};
const factory = vi.fn((opts: unknown) => ({
  opts,
  on: (event: string, _sel: string, fn: (e: unknown) => void) => {
    handlers[event] = fn;
  },
}));
vi.mock('cytoscape', () => ({ default: factory }));

describe('cytoscape renderer', () => {
  it('maps nodes and edges and forwards node taps', async () => {
    const { cytoscapeRenderer } = await import('../../web/src/graph.js');
    const onSelect = vi.fn();
    const container = document.createElement('div');
    cytoscapeRenderer(
      container,
      {
        nodes: [
          { id: '1', kind: 'bug', name: 'Timeout' },
          { id: '2', kind: 'alien', name: 'X' },
        ],
        edges: [{ src: '1', dst: '2', type: 'affects', weight: 1 }],
      },
      onSelect,
    );
    const opts = factory.mock.calls[0]![0] as {
      container: HTMLElement;
      elements: { data: Record<string, string> }[];
    };
    expect(opts.container).toBe(container);
    expect(opts.elements.map((e) => e.data)).toEqual([
      { id: '1', label: 'Timeout', color: '#c01048' },
      { id: '2', label: 'X', color: '#667085' },
      { id: 'e0', source: '1', target: '2', label: 'affects' },
    ]);
    handlers.tap!({ target: { id: () => '1' } });
    expect(onSelect).toHaveBeenCalledWith('1');
  });
});

describe('entry', () => {
  it('boots the app with the real API client and renderer', async () => {
    const boot = vi.fn(() => Promise.resolve('app'));
    vi.doMock('../../web/src/main.js', () => ({ boot }));
    await import('../../web/src/entry.js');
    expect(boot).toHaveBeenCalledOnce();
  });
});
