# `.github/workflows/`

`ci.yml` :

- **check** : règles du dépôt, formatage, lint, types, tests (100 % par fichier) sur un Postgres
  pgvector lancé par `docker compose`, build.
- **docker** : `docker compose up --build --wait` (healthchecks), démo de bout en bout par le faux
  Orqea, vérification qu'aucun secret n'est présent dans l'image.
