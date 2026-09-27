# `web/` — UI humaine

Vite + TypeScript + Cytoscape. Construite dans `dist/ui` et servie par l'API.

Au chargement, `#handoff=<jwt>` est lu dans le fragment d'URL (jamais envoyé au serveur par le
navigateur), effacé immédiatement de la barre d'adresse, puis échangé contre un cookie de session
limité au board. Sans jeton valide ni session : page 404.

Développement : `npm run build` puis ouvrir un lien de passation (`npm run demo`).
