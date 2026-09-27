# `test/` — tests

`npm test` (Vitest) exige **100 % de couverture par fichier** (instructions, branches, fonctions,
lignes) sur `src/`, `web/src/` et `fake-orqea/`. Les tests tournent sur le **vrai Postgres**
(pgvector) lancé par `docker compose up -d --wait postgres` (base `archipel_test`, remise à zéro à
chaque exécution par `global-setup.ts`).

| Fichier                                                           | Ce qu'il prouve                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolation.test.ts`                                               | Une île ne peut lire ni une autre île ni le schéma de contrôle (refus de Postgres) ; suppression complète (schéma, rôle, registre).                        |
| `lifecycle.test.ts`                                               | Idempotence, ordre des versions, suppression en cascade d'une carte, d'un document, d'un board ; effacement d'un utilisateur ; pannes du modèle, reprises. |
| `pipeline.test.ts`                                                | Ingestion → graphe → liens vers les consignes → requête avec citations.                                                                                    |
| `http-service.test.ts`                                            | Signature HMAC, anti-rejeu, limites, toutes les routes `/v1`.                                                                                              |
| `http-ui.test.ts`                                                 | Passation, session, 404, données de l'UI limitées au board de la session.                                                                                  |
| `http-edge.test.ts`                                               | Erreurs 500 sans contenu, budget de réponse, cas limites.                                                                                                  |
| `ai.test.ts`, `units.test.ts`, `security.test.ts`, `main.test.ts` | Unités.                                                                                                                                                    |
| `fake-orqea.test.ts`                                              | La démo complète sur HTTP.                                                                                                                                 |
| `web/`                                                            | UI sous jsdom.                                                                                                                                             |
