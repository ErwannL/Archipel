# `src/http/` — API HTTP

- `app.ts` : Fastify, en-têtes de sécurité (CSP stricte), erreurs converties en `{ error: code }`,
  journal par motif de route uniquement (jamais de corps ni de chaîne de requête).
- `service.ts` : routes `/v1/*` pour Orqea, toutes signées HMAC (voir `docs/CONTRACT.md`).
- `ui.ts` : échange du jeton de passation contre une session, et API de l'UI limitée au board de
  la session (404 sans session valide).
- `context.ts` : dépendances injectées et `HttpError`.
