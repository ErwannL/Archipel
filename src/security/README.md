# `src/security/` — authentification

- `hmac.ts` : signature des appels Orqea → Archipel (voir `docs/CONTRACT.md`).
- `jwt.ts` : vérification du jeton de passation (HS256 seulement, 60 s max).
- `session.ts` : cookie de session de l'UI, signé, limité à un board.
- `ratelimit.ts` : limitation de débit par board (fenêtre fixe d'une minute, par processus).
