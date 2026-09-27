# `src/query/` — lecture

- `query.ts` : requête GraphRAG d'une île : passages classés (similarité vectorielle + bonus si une
  entité nommée dans la question y est mentionnée, + bonus pour la carte courante), sous-graphe des
  entités de ces passages, liens vers les consignes, citations ; le tout dans `maxChars`.
- `budget.ts` : remplissage d'un budget de caractères (le premier élément qui dépasse est raccourci).
- `status.ts` : état par carte (`pending | processing | indexed | failed`) et progression du board.
- `explore.ts` : graphe complet et détail d'une entité pour l'UI.
