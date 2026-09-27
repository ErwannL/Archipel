# `src/ingest/` — ingestion

- `events.ts` : schéma (zod) des événements Orqea, et leur conversion en une opération normalisée :
  `upsert` (un « item » : carte, commentaire, checklist, compte rendu, document, fait),
  `delete` ou `deleteBoard`.
- `apply.ts` : application d'une opération. Un événement plus ancien que l'état connu (ou qu'une
  tombstone) est `stale` ; un rejeu de la même version est `duplicate`. Les upserts sont stockés
  puis mis en file (réponse rapide) ; **les suppressions sont appliquées immédiatement**, puis les
  entités orphelines sont supprimées.
