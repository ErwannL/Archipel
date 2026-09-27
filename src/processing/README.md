# `src/processing/` — construction du graphe

- `chunk.ts` : découpe Markdown en passages (par titre, puis par paragraphes, 900 caractères max).
- `pipeline.ts` : pour un item : embeddings et extraction **hors transaction**, puis remplacement
  atomique de sa part du graphe (passages, entités, mentions, relations). Si l'item a changé
  entre-temps, le résultat est jeté. Une erreur du modèle met l'item en `failed`.
- `links.ts` : lie chaque passage au passage de consigne le plus proche (`applies`, `contradicts`,
  ou `relates` si neutre), au-dessus d'un seuil de similarité.
- `worker.ts` : boucle de traitement de la file (reprises, abandon après `JOB_MAX_ATTEMPTS`).
