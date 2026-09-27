# `src/` — serveur Archipel

| Fichier / dossier | Rôle                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `main.ts`         | Point d'entrée unique (`main(env, 'api' \| 'worker' \| 'all')`), appelé par l'image Docker.              |
| `config.ts`       | Lecture et validation des variables d'environnement (les erreurs nomment la variable, jamais sa valeur). |
| `store/`          | Stockage Postgres : schéma de contrôle, îles (un schéma et un rôle par board), file de traitement.       |
| `ingest/`         | Format des événements Orqea et leur application (versions, tombstones, suppressions).                    |
| `processing/`     | Découpage, embeddings, extraction, écriture du graphe, liens vers les consignes, worker.                 |
| `query/`          | Requête GraphRAG avec budget, état de traitement, exploration pour l'UI.                                 |
| `erase/`          | Effacement d'un utilisateur (RGPD) dans toutes les îles.                                                 |
| `ai/`             | Fournisseurs de modèle interchangeables (faux déterministe, compatible OpenAI).                          |
| `security/`       | HMAC service à service, JWT de passation, cookie de session, limitation de débit.                        |
| `http/`           | Application Fastify : routes de service signées (`/v1`) et routes de l'UI (`/ui`).                       |
