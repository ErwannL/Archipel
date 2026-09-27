# Décisions techniques

Contrainte directrice : **des milliers d'îles strictement isolées sur une petite machine**, avec
une suppression réelle et vérifiable, sans exploitation lourde.

## 1. Stockage : PostgreSQL 16 + pgvector, un schéma et un rôle par board

**Choix.** Un seul Postgres. Chaque board est un schéma `isl_<hash>` possédé par un rôle Postgres
dédié `isl_<hash>` (NOLOGIN). Toute lecture ou écriture d'une île se fait dans une transaction qui
exécute `SET LOCAL ROLE isl_<hash>` et `SET LOCAL search_path TO isl_<hash>, public`. Le graphe
(entités, relations, mentions), l'index sémantique (passages + vecteurs) et l'index lexical
(`tsvector`) vivent dans les tables de ce schéma.

**Pourquoi.**

- L'isolation est garantie **par Postgres** : sous le rôle d'une île, lire une autre île ou le
  schéma de contrôle est refusé (`permission denied`), même si le code applicatif se trompait de
  filtre. Les tests le prouvent (`test/isolation.test.ts`).
- Suppression d'un board = `DROP SCHEMA … CASCADE` + `DROP ROLE` : rien ne peut rester dans une
  table partagée, et c'est vérifiable (route qui rend les comptes avant/après, et contrôle dans
  `pg_namespace` et `pg_roles`).
- Pas d'index partagé, donc pas de fuite possible par un index vectoriel global mal filtré (un
  risque classique des bases vectorielles multi-tenant avec filtre de métadonnées).
- Un graphe de board tient en quelques milliers de nœuds : des tables relationnelles et des
  jointures suffisent (voisinage, sous-graphe), avec transactions et cascades.
- Une seule brique à exploiter, sauvegarder et superviser.

**Limites connues et parades.**

- `SET ROLE` est vérifié par Postgres contre l'utilisateur **de connexion** (`archipel_app`), qui a
  le droit de devenir n'importe quelle île. Le code d'une île passe donc par `IslandTx.query`, qui
  refuse toute instruction contenant `ROLE`, `SESSION AUTHORIZATION`, `search_path` ou
  `set_config`. Le texte SQL est toujours écrit dans le code (jamais construit à partir des
  données, qui passent en paramètres).
- Des milliers de schémas grossissent le catalogue Postgres (≈ 7 tables + index par île) ; c'est
  bien supporté jusqu'à quelques dizaines de milliers de schémas. Au-delà : partitionner sur
  plusieurs bases (le nom de schéma dépend déjà de la base).
- Recherche vectorielle **exacte** (pas d'index HNSW) : les passages d'un board sont peu nombreux
  (quelques milliers), un parcours exact prend quelques millisecondes et ne dépend pas de la
  dimension. Ajouter un HNSW par île reste possible si un board devient très gros.
- Le rôle applicatif a `CREATEROLE` (pas superutilisateur) pour créer les rôles d'île.

**Écartés.**

- _Neo4j / Memgraph_ : une base par board est irréaliste à l'échelle (Neo4j Community n'a qu'une
  base) ; un graphe partagé filtré par propriété ne satisfait pas l'isolation au niveau stockage.
  Mémoire importante (JVM) pour une petite machine.
- _Une base vectorielle dédiée (Qdrant, Weaviate, Milvus)_ : isolation par collection possible,
  mais deuxième système à synchroniser avec le graphe, suppression en deux endroits, des milliers
  de collections coûteuses.
- _Un fichier SQLite par board_ : isolation physique séduisante, mais écritures concurrentes
  API/worker, milliers de fichiers ouverts, sauvegarde et extension vectorielle plus fragiles.
- _Row-Level Security avec `board_id` partout_ : isolation réelle mais tables et index partagés,
  et suppression moins nette à prouver.

## 2. File de traitement : table Postgres + `FOR UPDATE SKIP LOCKED`

**Choix.** Table `archipel.jobs` (ids seulement), un job par item, bail (`locked_until`), reprises
avec backoff exponentiel, compteur `seq` pour ne pas perdre une mise à jour arrivée pendant le
traitement.

**Pourquoi.** Zéro composant de plus ; transactionnel avec le reste ; suffisant pour le débit d'un
outil collaboratif ; plusieurs workers possibles sans double traitement.

**Écartés.** Redis/BullMQ, RabbitMQ : un service de plus à exploiter et à sécuriser pour aucun gain
à cette échelle.

## 3. Langage et bibliothèques : TypeScript sur Node 22

- Même écosystème qu'Orqea (Node/Express) : la personne qui branchera Archipel lit le même
  langage ; `fake-orqea/client.ts` peut être copié tel quel.
- **Fastify** : validation et gestion d'erreurs simples, `inject()` pour tester sans réseau.
- **zod** : un seul schéma pour valider les événements et typer le code.
- **pg** (node-postgres) : SQL explicite, nécessaire pour les rôles, schémas et pgvector.
- **pino** : journaux JSON structurés.
- **Vitest** + couverture v8 : seuils à 100 % **par fichier** dans `vitest.config.ts` (le build
  échoue en dessous).
- **UI : Vite + TypeScript + Cytoscape.js** (graphe), sans framework : peu de code, entièrement
  testable sous jsdom.
- JWT HS256 et HMAC implémentés avec `node:crypto` (~40 lignes) plutôt qu'une dépendance : on
  n'accepte qu'un seul algorithme, sans surface inutile (`alg: none`, clés publiques…).

Règle de lint : `no-non-null-assertion` est désactivée. Avec `noUncheckedIndexedAccess`, `x!`
marque un accès que le code garantit ; le remplacer par `x ?? valeur` créerait une branche qui ne
s'exécute jamais, ce qu'interdit la règle « une branche inatteignable se supprime ».

## 4. Modèle : adaptateur, faux déterministe par défaut

- `ModelProvider` = `embed()` + `extract()`. Le **faux** (par défaut, sans clé ni réseau) :
  embeddings par hachage de mots et de trigrammes (proximité lexicale réelle, reproductible) et
  extraction par règles (voir `src/ai/README.md`). Il sert aux tests, à la démo et au mode local.
- Le **vrai** : tout point d'accès **compatible OpenAI** (`/embeddings`, `/chat/completions` en
  JSON). Un seul adaptateur couvre OpenAI, Ollama (local, sans données sortantes), vLLM, Mistral…
- Chaque vecteur est stocké avec l'id du modèle ; une requête ne compare que des vecteurs du même
  modèle.
- Les appels au modèle se font **hors transaction** ; une panne met l'item `failed` et le job est
  retenté ; l'ingestion ne dépend jamais du modèle.

## 5. Événements = instantanés versionnés

Orqea envoie l'état courant de chaque objet avec une `version` (son horodatage en ms). Cela rend
l'idempotence et l'ordre triviaux (plus grand gagne, égal = doublon) sans stocker d'historique ni
d'identifiants d'événements. Les suppressions laissent une tombstone (id + version, sans contenu)
pour qu'un événement en retard ne ressuscite rien.

## 6. Suppressions synchrones, traitement asynchrone

Les ajouts sont mis en file (réponse `202` rapide). Les suppressions (objet, carte, board,
utilisateur) sont appliquées **avant** de répondre : quand Orqea reçoit la réponse, la donnée n'est
plus là. Une suppression de carte ou de board est une poignée de `DELETE` / un `DROP SCHEMA`,
rapide.

## 7. Liens vers les consignes

Chaque passage non-consigne est relié à la section de consigne la plus proche (similarité cosinus).
Le type du lien vient de la position du passage (`applies`, `contradicts`, sinon `relates`). Un
passage qui se positionne explicitement a un seuil plus bas (0,15) qu'un passage neutre (0,3). Les
liens sont recalculés quand une consigne change ou disparaît.

## 8. Sécurité et journaux

- HMAC avec horodatage **et** nonce à usage unique (le seul horodatage laisse rejouer une requête
  dans la fenêtre).
- Jeton de passation dans le fragment d'URL, 60 s, usage unique, échangé contre un cookie
  `HttpOnly; SameSite=Strict` limité à un board ; toute l'UI renvoie 404 sans session.
- CSP stricte (`script-src 'self'`, pas de `unsafe-inline` ; seul le `<style>` fixe injecté par
  Cytoscape est autorisé par son empreinte), `frame-ancestors` limité aux origines d'Orqea (`ARCHIPEL_FRAME_ANCESTORS`, l'UI s'affiche dans une modale d'Orqea), `no-referrer`, `nosniff`.
- Journaux : motif de route, statut, durée, ids, codes d'erreur. **Jamais** de corps, de chaîne de
  requête, de message d'erreur Postgres (qui peut citer des valeurs) ni de texte du modèle.
- Conteneurs : utilisateur non-root, système de fichiers en lecture seule, `no-new-privileges`,
  ports publiés sur 127.0.0.1 uniquement, aucun secret dans l'image (secrets par `.env` au
  lancement ; le CA optionnel de build passe par un secret BuildKit, jamais dans une couche).
