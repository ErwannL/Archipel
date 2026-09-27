#!/bin/sh
# Runs once, as the Postgres superuser, on an empty data directory.
# Creates the unprivileged application role (CREATEROLE only, not superuser),
# the application databases, and the pgvector extension.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_pw="$ARCHIPEL_DB_PASSWORD" <<'SQL'
CREATE ROLE archipel_app LOGIN CREATEROLE NOSUPERUSER NOCREATEDB PASSWORD :'app_pw';
CREATE DATABASE archipel OWNER archipel_app;
CREATE DATABASE archipel_test OWNER archipel_app;
SQL
for db in archipel archipel_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $db TO archipel_app;
SQL
done
