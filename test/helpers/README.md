# `test/helpers/` — outils de test

- `env.ts` : environnement de test (base `archipel_test`, secrets de test).
- `db.ts` : pool Postgres et identifiants de board uniques par test.
- `app.ts` : application de test, requêtes signées HMAC, jetons de passation.
- `events.ts` : fabrication d'événements Orqea valides.
