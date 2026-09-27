# Archipel by Orqea

La **mémoire GraphRAG** d'un board Orqea. Chaque board est une île : son propre graphe de
connaissances et son propre index sémantique, totalement isolés. Archipel en contient des milliers,
et aucun pont ne les relie jamais.

- **Ingestion** : Orqea pousse les événements du board (cartes, commentaires, checklists, comptes
  rendus d'agents, documents de consignes, suppressions), signés HMAC.
- **Graphe + index par board** : entités (personnes, composants, décisions, bugs, notions),
  relations, passages citables, liens explicites entre un compte rendu et la consigne qu'il
  applique ou contredit.
- **Requête pour les agents** : passages + sous-graphe + citations, dans un budget de taille donné.
- **Écriture par les agents** : faits rattachés à la carte traitée.
- **UI humaine** : graphe, recherche, détail d'une entité et de ses sources, état de traitement ;
  ouverte par un jeton de passation d'Orqea.
- **État** : `pending | processing | indexed | failed` par carte, progression par board.
- **Suppression réelle** d'une carte, d'un board entier (comptes avant/après) ou de tout ce qui
  vient d'un utilisateur.

## Démarrer

Prérequis : Docker (avec compose) et Node 22.

```sh
cp .env.example .env        # puis remplacer les secrets
docker compose up -d --build --wait
npm ci
npm run demo                # le faux Orqea pousse un board de démonstration et ouvre l'UI
```

L'API et l'UI écoutent sur `http://127.0.0.1:8080` (santé : `/healthz`). Sans jeton de passation,
l'UI répond 404 : c'est voulu.

## Développer

```sh
docker compose up -d --wait postgres   # Postgres pgvector pour les tests
npm run check    # règles du dépôt, formatage, lint, types, tests (100 % par fichier), build
npm test         # tests + couverture
```

## Documentation

| Document                                     | Contenu                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/CONTRACT.md`](docs/CONTRACT.md)       | Contrat exact pour Orqea : routes, événements, signature HMAC (exemple calculable), jeton de passation, erreurs, limites, variables. |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | Passation : ce qui est fait, hypothèses sur Orqea, ce qu'il reste à brancher.                                                        |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)     | Choix techniques et alternatives écartées.                                                                                           |
| [`docs/PRIVACY.md`](docs/PRIVACY.md)         | Données stockées, durée, effacement.                                                                                                 |

## Organisation

| Dossier       | Contenu                                             |
| ------------- | --------------------------------------------------- |
| `src/`        | Serveur (API, worker, stockage, pipeline, requête). |
| `web/`        | UI humaine.                                         |
| `fake-orqea/` | Faux Orqea pour la démonstration de bout en bout.   |
| `test/`       | Tests unitaires et d'intégration (vrai Postgres).   |
| `docker/`     | Initialisation de Postgres.                         |
| `scripts/`    | Vérifications du dépôt.                             |
| `docs/`       | Documentation.                                      |
