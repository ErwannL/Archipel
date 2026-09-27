# `web/src/` — code de l'UI

- `entry.ts` : démarrage dans le navigateur.
- `main.ts` : lecture du jeton de passation, session, 404.
- `api.ts` : client JSON de l'API `/ui`.
- `views.ts` : jauge, recherche, résultats avec citations, détail d'entité, état des cartes (titre, état traduit, mise à jour, raison d'échec,
  alerte « worker arrêté ? » si un élément attend depuis plus de 5 min).
- `brand.ts` : marque commune à tous les écrans (même ensemble que SportSplitter by Orqea) :
  « Archipel by Orqea », « Propulsé par Orqea » (lien `ARCHIPEL_ORQEA_URL`, lu sur `/healthz`),
  « Développé par Erwann Laplante », « Retour sur Orqea », chargeur animé, page 404.
- `logo.ts` : le logo (trois îles reliées), modes `static` / `hover` / `loop` (chargement).
- `graph.ts` : rendu du graphe (Cytoscape).
- `dom.ts` : construction du DOM (texte toujours inséré comme texte, jamais comme HTML).
- `style.css` : styles (clair / sombre).
