import cytoscape from 'cytoscape';
import type { Graph } from './api.js';

export type GraphRenderer = (
  container: HTMLElement,
  graph: Graph,
  onSelect: (id: string) => void,
) => void;

export const KIND_COLORS: Record<string, string> = {
  person: '#7a5af8',
  component: '#2f6fed',
  decision: '#12805c',
  bug: '#c01048',
  concept: '#b54708',
  card: '#0e9384',
};

export const cytoscapeRenderer: GraphRenderer = (container, graph, onSelect) => {
  const cy = cytoscape({
    container,
    elements: [
      ...graph.nodes.map((n) => ({
        data: { id: n.id, label: n.name, color: KIND_COLORS[n.kind] ?? '#667085' },
      })),
      ...graph.edges.map((e, i) => ({
        data: { id: `e${i}`, source: e.src, target: e.dst, label: e.type },
      })),
    ],
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'background-color': 'data(color)',
          'font-size': 10,
          color: '#667085',
        },
      },
      {
        selector: 'edge',
        style: {
          label: 'data(label)',
          'font-size': 8,
          width: 1,
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'line-color': '#98a2b3',
          'target-arrow-color': '#98a2b3',
          color: '#98a2b3',
        },
      },
    ],
    layout: { name: 'cose', animate: false },
  });
  cy.on('tap', 'node', (evt) => {
    onSelect((evt.target as cytoscape.NodeSingular).id());
  });
};
