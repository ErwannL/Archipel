# `src/store/` — stockage et isolation

- `control.ts` : schéma `archipel` (registre des îles, tombstones de board, utilisateurs effacés,
  file de jobs, nonces anti-rejeu, jetons de passation consommés). **Uniquement des ids et des
  versions, jamais de contenu.** Aucun rôle d'île n'y a accès.
- `islands.ts` : une île = un schéma Postgres `isl_<hash>` possédé par un rôle `isl_<hash>` (NOLOGIN).
  `withIsland()` ouvre une transaction, fait `SET LOCAL ROLE` + `SET LOCAL search_path` sur l'île,
  et refuse toute instruction qui tenterait d'en sortir. Le rôle n'a aucun droit sur les autres
  îles : l'isolation est garantie par Postgres. `dropIsland()` supprime schéma, rôle et registre.
- `island-ddl.ts` : tables d'une île (`items`, `tombstones`, `passages`, `entities`, `mentions`,
  `relations`, `guideline_links`).
- `jobs.ts` : file de traitement (`FOR UPDATE SKIP LOCKED`, bail, reprises avec backoff exponentiel).
