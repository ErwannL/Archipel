import { createApi } from './api.js';
import { cytoscapeRenderer } from './graph.js';
import { boot } from './main.js';

void boot(window, createApi(), cytoscapeRenderer);
