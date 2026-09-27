# Contrat d'intégration Orqea ↔ Archipel

Ce document décrit **tout** ce qu'Orqea doit faire pour utiliser Archipel. Il est vérifié par
les tests (`test/security.test.ts` recalcule les deux exemples de signature ci-dessous).

- Base URL : `ARCHIPEL_URL` côté Orqea, par exemple `http://archipel-api:8080` sur le réseau Docker.
- Tout est en JSON UTF-8 (`content-type: application/json`).
- Aucune route `/v1` n'est ouverte : **chaque appel est signé** (HMAC, §1).
- Les erreurs ont toujours la forme `{ "error": "<code>" }` (plus `fields` pour `invalid_request`).
  Elles ne contiennent jamais de contenu (ni texte de carte, ni question).

## Sommaire

1. [Signature HMAC des appels](#1-signature-hmac-des-appels)
2. [Événements (ingestion)](#2-événements-ingestion)
3. [Routes de service](#3-routes-de-service)
4. [Passation vers l'UI humaine](#4-passation-vers-lui-humaine)
5. [Codes d'erreur](#5-codes-derreur)
6. [Limites](#6-limites)
7. [Variables d'environnement](#7-variables-denvironnement)
8. [Brancher Archipel dans le docker compose d'Orqea](#8-brancher-archipel-dans-le-docker-compose-dorqea)

---

## 1. Signature HMAC des appels

Secret partagé : `ARCHIPEL_HMAC_SECRET` (≥ 32 caractères, **différent** du secret de passation).

Chaque requête vers `/v1/*` porte trois en-têtes :

| En-tête                | Valeur                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-archipel-timestamp` | Heure Unix **en secondes** (entier). Doit être à ±`SIGNATURE_WINDOW_SECONDS` (300 s) de l'horloge d'Archipel.                                                         |
| `x-archipel-nonce`     | Valeur aléatoire unique, 16 à 128 caractères `[A-Za-z0-9_-]` (ex. 16 octets en hex). **Jamais réutilisée** : Archipel refuse un nonce déjà vu pendant 2 × la fenêtre. |
| `x-archipel-signature` | `v1=` + HMAC-SHA256 hexadécimal (minuscules) de la chaîne canonique.                                                                                                  |

Chaîne canonique : cinq lignes jointes par `\n` (sans `\n` final) :

```
<timestamp>
<nonce>
<MÉTHODE en majuscules>
<chemin + chaîne de requête exactement comme envoyés, ex. /v1/boards/b-7?version=12>
<sha256 hexadécimal du corps brut (chaîne vide si pas de corps)>
```

Le corps signé doit être **exactement** les octets envoyés : sérialisez une fois, signez, envoyez
cette même chaîne.

### Exemple calculable

```
secret    = example-hmac-secret-please-change-0123456789
timestamp = 1700000000
nonce     = 3f2a9c1e5b7d4f60a8e2c4b6d8f0a1b3
méthode   = POST
chemin    = /v1/events
corps     = {"events":[]}
sha256(corps) = 24de1c4a19c43ad41b013f13dcd858c17b0daa7f33a53f19913e5b11366d1c2e
signature = v1=6c662205c14ce6357926aebc494b867935a2027820176391be83d3046db2679f
```

### Implémentation Node (à copier dans Orqea)

```js
import { createHash, createHmac, randomBytes } from 'node:crypto';

export async function archipelCall(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const canonical = [
    ts,
    nonce,
    method,
    path,
    createHash('sha256').update(payload).digest('hex'),
  ].join('\n');
  const signature =
    'v1=' + createHmac('sha256', process.env.ARCHIPEL_HMAC_SECRET).update(canonical).digest('hex');
  const res = await fetch(process.env.ARCHIPEL_URL + path, {
    method,
    headers: {
      'x-archipel-timestamp': ts,
      'x-archipel-nonce': nonce,
      'x-archipel-signature': signature,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: payload }),
  });
  return { status: res.status, body: await res.json() };
}
```

(`fake-orqea/client.ts` est la même chose en TypeScript.)

---

## 2. Événements (ingestion)

Orqea pousse ce qui se passe dans un board. **Un événement est un instantané de l'état courant de
l'objet, pas un diff** : pour une carte, envoyez toujours titre, description, liste et étiquettes
courants, même pour un simple déplacement.

### Enveloppe

```json
{
  "eventId": "7b0e…",           // chaîne 1–128, unique (sert au suivi dans la réponse)
  "boardId": "42",              // chaîne 1–128 : l'île
  "type": "card.updated",
  "version": 1790516521154,     // entier ≥ 0 : horodatage de l'objet en millisecondes (updatedAt)
  "data": { … }                 // selon le type
}
```

Tous les identifiants (`boardId`, `cardId`, `commentId`, `checklistId`, `reportId`, `docId`,
`authorId`, `agentId`) sont des **chaînes** de 1 à 128 caractères. Des ids numériques MySQL
doivent être envoyés en chaîne (`"42"`).

### `version`, ordre et idempotence

- `version` = l'horodatage de mise à jour de l'objet en ms (ou tout entier croissant **par objet**).
  Pour une suppression, l'heure de la suppression.
- Même version déjà connue → `duplicate` (aucun effet). Version plus ancienne que l'état connu →
  `stale` (aucun effet). Un rejeu ne duplique donc jamais rien.
- Une suppression laisse une _tombstone_ (id + version, sans contenu) : un événement en retard sur
  un objet supprimé est `stale`. Une carte supprimée à la version V rend `stale` tout événement de
  version ≤ V sur ses commentaires, checklists et comptes rendus.
- Un board supprimé à la version V rend `stale` tout événement de ce board de version ≤ V.
- Un utilisateur effacé à la version V rend `stale` tout événement dont il est l'auteur de
  version ≤ V.

### Types

| `type`                                       | `data`                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `card.created`, `card.updated`, `card.moved` | `cardId`, `title` (≤ 1000), `description` (≤ 100 000, défaut `""`), `listName?` (≤ 500), `labels?` (≤ 50 × ≤ 100, défaut `[]`), `authorId?`, `authorName?` (≤ 200)                |
| `card.deleted`                               | `cardId` — supprime aussi tout ce qui est rattaché à la carte (commentaires, checklists, comptes rendus, faits d'agents)                                                          |
| `comment.created`, `comment.updated`         | `commentId`, `cardId`, `text` (≤ 100 000), `authorId?`, `authorName?`                                                                                                             |
| `comment.deleted`                            | `commentId`, `cardId`                                                                                                                                                             |
| `checklist.created`, `checklist.updated`     | `checklistId`, `cardId`, `title` (≤ 1000), `items` : `[{ "text": ≤ 2000, "done": bool }]` (≤ 500), `authorId?`, `authorName?`                                                     |
| `checklist.deleted`                          | `checklistId`, `cardId`                                                                                                                                                           |
| `report.created`, `report.updated`           | Compte rendu d'agent écrit dans une carte : `reportId`, `cardId`, `text` (≤ 200 000, Markdown), `agentId?`, `authorId?` (l'utilisateur pour qui l'agent travaille), `authorName?` |
| `report.deleted`                             | `reportId`, `cardId`                                                                                                                                                              |
| `doc.created`, `doc.updated`                 | Document de consignes du board : `docId`, `title` (≤ 1000), `markdown` (≤ 200 000), `authorId?`, `authorName?`                                                                    |
| `doc.deleted`                                | `docId`                                                                                                                                                                           |
| `board.deleted`                              | `{}` — supprime toute l'île (équivalent à `DELETE /v1/boards/:boardId`)                                                                                                           |

`authorId` sert à l'effacement de compte (§3.9) : envoyez-le toujours quand il est connu.
`authorName` est le nom affiché de la personne dans le graphe.

Les documents de consignes sont découpés par titres Markdown : chaque section devient un passage
citable (`section` dans les réponses). Un passage qui dit appliquer une consigne
(« conformément à… », « selon la consigne… ») ou la contredire (« contrairement à… »,
« malgré… », « ne respecte pas… ») est relié à la section la plus proche par un lien `applies` ou
`contradicts` ; sinon, s'il est assez proche, par `relates`.

### `POST /v1/events`

Corps : `{ "events": [ …1 à 100 événements… ] }`. Tout le lot est validé **avant** d'appliquer quoi
que ce soit (un événement invalide ⇒ rien n'est appliqué). Les événements sont ensuite appliqués
dans l'ordre du tableau.

Réponse `202` :

```json
{ "results": [{ "eventId": "7b0e…", "outcome": "queued" }] }
```

| `outcome`   | Sens                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `queued`    | Stocké, traitement (extraction, embeddings) en file. La carte passe `pending`.  |
| `applied`   | Suppression appliquée **immédiatement** (déjà effacée quand la réponse arrive). |
| `duplicate` | Déjà connu à cette version : rien fait.                                         |
| `stale`     | Plus ancien que l'état connu, ou objet/board/auteur effacé : rien fait.         |

L'ingestion ne dépend jamais du modèle : elle répond même si le modèle est en panne.

---

## 3. Routes de service

Toutes signées (§1). `:boardId`, `:cardId`, `:userId`, `:factId` : chaînes 1–128, encodées dans
l'URL (`encodeURIComponent`) ; signez le chemin **encodé**, tel qu'envoyé.

### 3.1 `GET /v1/boards/:boardId/status` — jauge « en mémoire »

`200` :

```json
{
  "boardId": "42",
  "progress": 0.75,
  "totals": { "pending": 1, "processing": 0, "indexed": 3, "failed": 0 },
  "cards": [{ "cardId": "101", "status": "indexed", "items": 3 }]
}
```

- `progress` = éléments indexés / total (0 à 1, 3 décimales ; `1` si le board est vide ou inconnu).
- Statut d'une carte = le pire de ses éléments (carte, commentaires, checklists, comptes rendus,
  faits) : `failed` > `processing` > `pending` > `indexed`.
- Board inconnu : `200` avec `progress: 1`, compteurs à zéro, `cards: []`.

### 3.2 `GET /v1/boards/:boardId/cards/:cardId/status`

`200` : `{ "boardId": "42", "cardId": "101", "status": "pending", "items": 2 }`.
`404 card_not_found` si Archipel ne connaît rien de cette carte.

### 3.3 `POST /v1/boards/:boardId/query` — mémoire pour un agent

Corps :

| Champ       | Type               | Défaut | Sens                                                                                         |
| ----------- | ------------------ | ------ | -------------------------------------------------------------------------------------------- |
| `question`  | chaîne 1–2000      | —      | Question en langage naturel.                                                                 |
| `maxChars`  | entier 500–200 000 | —      | Taille maximale de la réponse JSON sérialisée, en caractères.                                |
| `maxTokens` | entier 125–50 000  | 2000   | Alternative à `maxChars` (converti en `maxTokens × 4` caractères). Exclusif avec `maxChars`. |
| `topK`      | entier 1–50        | 8      | Nombre maximal de passages.                                                                  |
| `cardId`    | chaîne             | —      | Carte traitée par l'agent : ses passages sont légèrement favorisés.                          |

`200` :

```json
{
  "passages": [
    {
      "passageId": "12",
      "itemKey": "report:r-2",
      "kind": "report",
      "cardId": "102",
      "docId": null,
      "heading": "",
      "text": "Correctif temporaire : contrairement à la consigne, …",
      "score": 0.912
    }
  ],
  "graph": {
    "nodes": [{ "id": "4", "kind": "component", "name": "PaymentGateway" }],
    "edges": [{ "src": "3", "dst": "4", "type": "depends_on", "weight": 2 }]
  },
  "guidelineLinks": [
    {
      "fromPassage": "12",
      "toPassage": "1",
      "docId": "regles-paiement",
      "section": "Paiements",
      "type": "contradicts",
      "score": 0.237
    }
  ],
  "citations": [
    {
      "itemKey": "report:r-2",
      "kind": "report",
      "cardId": "102",
      "docId": null,
      "passageIds": ["12"]
    }
  ],
  "usedChars": 3989,
  "truncated": true
}
```

- `usedChars` ≤ `maxChars` (garanti) ; `truncated: true` si quelque chose a été coupé ou omis.
  Le premier passage qui ne tient pas est raccourci (terminé par `…`), les suivants sont omis.
- Répartition du budget : passages + citations d'abord (~70 %), puis liens vers les consignes,
  arêtes, nœuds.
- `itemKey` = `<kind>:<id Orqea>`. `kind` ∈ `card`, `comment`, `checklist`, `report`, `doc`, `fact`.
  Pour citer : `cardId` (carte) ou `docId` + `heading`/`section` (document de consignes).
- `node.kind` ∈ `person`, `component`, `decision`, `bug`, `concept`.
- Les ids de nœuds et de passages sont internes à l'île : stables tant que la source ne change pas.
- `404 board_not_found` si le board n'a aucune mémoire.

### 3.4 `POST /v1/boards/:boardId/facts` — un agent écrit dans la mémoire

```json
{
  "cardId": "101",
  "agentId": "agent-dev",
  "authorId": "u-7",
  "authorName": "Alice",
  "version": 1790516521154,
  "facts": [{ "factId": "f-1", "text": "Décidé : le module `Y` dépend de `Z`." }]
}
```

- `cardId` (obligatoire) : la carte traitée. Supprimer la carte supprime ses faits.
- `factId` (obligatoire, 1–128) : identifiant choisi par Orqea, **clé d'idempotence**. Réécrire le
  même `factId` avec une `version` plus grande remplace le fait.
- `version` optionnelle (défaut : maintenant, en ms) ; `text` 1–4000 ; 1 à 50 faits par appel.
- `authorId` : l'utilisateur pour qui l'agent travaille (pour l'effacement de compte). À défaut,
  `authorName`, puis `agentId`, sert de nom d'auteur.
- Formes reconnues par l'extraction par défaut : `Décidé : …`, `Bug : …`, « X dépend de Y »,
  « X remplace Y », « X utilise Y », `` `Composant` ``, `@personne`, `#notion`.

`202` : `{ "results": [ { "factId": "f-1", "outcome": "queued" } ] }`.

### 3.5 `DELETE /v1/boards/:boardId/facts/:factId[?version=<ms>]`

`200` : `{ "factId": "f-1", "outcome": "applied" | "duplicate" | "stale" }`.

### 3.6 `GET /v1/boards/:boardId/stats` — comptes vérifiables

`200` :

```json
{
  "boardId": "42",
  "exists": true,
  "counts": {
    "items": 10,
    "tombstones": 1,
    "passages": 14,
    "entities": 22,
    "mentions": 51,
    "relations": 9,
    "guideline_links": 3
  }
}
```

### 3.7 `DELETE /v1/boards/:boardId[?version=<ms>]` — suppression totale d'une île

Supprime le schéma entier (toutes les tables, en cascade), le rôle Postgres de l'île, sa file de
traitement et son entrée au registre. Ne garde qu'une tombstone `(boardId, version)` pour refuser
les événements en retard. Idempotent.

`200` :

```json
{
  "boardId": "42",
  "deleted": true,
  "before": {
    "items": 10,
    "tombstones": 1,
    "passages": 14,
    "entities": 22,
    "mentions": 51,
    "relations": 9,
    "guideline_links": 3
  },
  "after": {
    "items": 0,
    "tombstones": 0,
    "passages": 0,
    "entities": 0,
    "mentions": 0,
    "relations": 0,
    "guideline_links": 0
  },
  "exists": false
}
```

`version` par défaut : maintenant. Si le board est recréé plus tard dans Orqea avec le même id,
envoyez des versions supérieures à celle de la suppression.

### 3.8 `POST /v1/boards/:boardId/retry`

Remet en file les éléments `failed` (et `pending` orphelins) du board. `202` : `{ "requeued": 3 }`.
`404 board_not_found` si le board n'a aucune mémoire.

### 3.9 `POST /v1/users/:userId/erase` — effacement de compte (RGPD)

Corps optionnel : `{ "version": <ms> }` (défaut : maintenant). Dans **toutes** les îles :

- supprime la mémoire dérivée de tout ce dont `userId` est l'auteur (`authorId`) : ses cartes,
  commentaires, checklists, comptes rendus et faits faits pour lui, documents de consignes ;
  avec leurs passages, embeddings, mentions, relations et liens, puis les entités orphelines ;
- anonymise son entité « personne » (« Utilisateur effacé ») là où d'autres sources la citent
  encore ;
- ne touche **pas** aux éléments dont il n'est pas l'auteur (qui peuvent contenir son nom : c'est
  le contenu d'autres personnes, qui reste dans Orqea et dans la mémoire tant qu'il existe dans
  Orqea) ;
- ignore ensuite les événements de cet auteur de version ≤ `version`.

Archipel ne supprime rien dans Orqea : il n'efface que sa mémoire.

`200` : `{ "userId": "u-7", "boardsScanned": 120, "itemsRemoved": 37, "entitiesAnonymized": 2 }`.

---

## 4. Passation vers l'UI humaine

L'UI n'a pas de comptes. Pour ouvrir la mémoire d'un board à un utilisateur qui y a accès dans
Orqea, Orqea fabrique un lien :

```
<ARCHIPEL_PUBLIC_URL>/#handoff=<jwt>
```

- Le jeton est dans le **fragment** (`#`) : il n'est jamais envoyé à un serveur, ni dans les
  journaux, ni dans `Referer`. L'UI l'efface de la barre d'adresse dès le chargement.
- JWT **HS256** signé avec `ARCHIPEL_HANDOFF_SECRET` (≥ 32 caractères, différent du secret HMAC).
- Charge utile (toutes obligatoires) :

  | Claim     | Type         | Contrainte                                          |
  | --------- | ------------ | --------------------------------------------------- |
  | `userId`  | chaîne 1–128 | L'utilisateur Orqea.                                |
  | `boardId` | chaîne 1–128 | Le **seul** board accessible avec ce jeton.         |
  | `iat`     | entier (s)   | Pas dans le futur (tolérance 5 s).                  |
  | `exp`     | entier (s)   | Dans le futur (tolérance 5 s), et `exp − iat ≤ 60`. |

- En-tête : `{"alg":"HS256","typ":"JWT"}` (`alg` doit être `HS256` ; `none` et les autres sont refusés).
- **Usage unique** : un jeton déjà échangé est refusé.
- Orqea doit vérifier que l'utilisateur a accès au board **avant** de fabriquer le lien : Archipel
  fait confiance au jeton.
- Le jeton est échangé contre un cookie `archipel_session` (`HttpOnly`, `SameSite=Strict`,
  `Path=/ui`, `Secure` si `COOKIE_SECURE=true`), valable `SESSION_TTL_SECONDS` (30 min), limité à
  ce board. Toutes les routes de l'UI prennent le board **dans la session**, jamais dans l'URL.
- Jeton absent, invalide, expiré ou déjà utilisé : **404**.

Exemple calculable (secret `example-handoff-secret-please-change-01234`, `userId` `u-42`,
`boardId` `b-7`, `iat` 1700000000, `exp` 1700000060) :

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1LTQyIiwiYm9hcmRJZCI6ImItNyIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDYwfQ.SHYJeYfQlLNN6loQxu7fa9sSXGprmbhEZxcYbL-J8dk
```

En Node : `jsonwebtoken.sign({ userId, boardId }, secret, { algorithm: 'HS256', expiresIn: 60 })`
produit un jeton conforme (il ajoute `iat` et `exp`).

L'UI s'ouvre dans un nouvel onglet (elle refuse d'être affichée dans un iframe :
`frame-ancestors 'none'`).

Routes internes de l'UI (appelées par l'UI elle-même, pas par Orqea) : `POST /ui/session`,
`DELETE /ui/session`, `GET /ui/api/overview`, `GET /ui/api/graph`, `GET /ui/api/entities/:id`,
`POST /ui/api/search`.

---

## 5. Codes d'erreur

| HTTP | `error`                        | Cause                                                                |
| ---- | ------------------------------ | -------------------------------------------------------------------- |
| 400  | `invalid_request` (+ `fields`) | Corps ou paramètres invalides ; `fields` liste les chemins en cause. |
| 400  | `invalid_event:<i>`            | L'événement d'index `i` du lot est invalide (rien n'a été appliqué). |
| 400  | `invalid_json`                 | Corps non JSON.                                                      |
| 401  | `signature_missing`            | En-tête absent, horodatage non numérique ou nonce mal formé.         |
| 401  | `signature_stale`              | Horodatage hors fenêtre (vérifier l'horloge, NTP).                   |
| 401  | `signature_bad_signature`      | Signature fausse (secret, chemin, corps…).                           |
| 401  | `signature_replayed`           | Nonce déjà utilisé.                                                  |
| 404  | `board_not_found`              | Board sans mémoire (requête, retry).                                 |
| 404  | `card_not_found`               | Carte inconnue (statut de carte).                                    |
| 404  | `not_found`                    | Route inconnue ; UI sans session valide.                             |
| 413  | `event_too_large:<i>`          | L'événement `i` dépasse `MAX_EVENT_BYTES`.                           |
| 413  | `payload_too_large`            | Corps > 4 Mio.                                                       |
| 415  | `unsupported_media_type`       | `content-type` autre que `application/json`.                         |
| 429  | `rate_limited`                 | Débit dépassé pour ce board ; réessayer après quelques secondes.     |
| 500  | `internal_error`               | Erreur interne (journalisée par code uniquement) ; réessayable.      |

Côté Orqea : réessayer 429, 500, 502, 503 et les erreurs réseau avec backoff (les événements sont
idempotents, les rejouer est sans risque). Ne pas réessayer 400/401/404/413 sans correction.

---

## 6. Limites

| Limite                                     | Valeur                                                                               | Réglage                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| Corps de requête                           | 4 Mio                                                                                | fixe                                      |
| Taille d'un événement (JSON, octets UTF-8) | 256 Kio                                                                              | `MAX_EVENT_BYTES`                         |
| Événements par lot                         | 1 à 100                                                                              | fixe                                      |
| Faits par appel                            | 1 à 50 (texte ≤ 4000)                                                                | fixe                                      |
| Débit                                      | 1200 requêtes / minute / board / processus API (routes sans board : compteur commun) | `RATE_LIMIT_PER_MINUTE`                   |
| Fenêtre de signature                       | ±300 s                                                                               | `SIGNATURE_WINDOW_SECONDS`                |
| Question                                   | 2000 caractères                                                                      | fixe                                      |
| Réponse de requête                         | 500 à 200 000 caractères                                                             | `maxChars` / `maxTokens`                  |
| Jeton de passation                         | 60 s, usage unique                                                                   | fixe                                      |
| Session UI                                 | 30 min                                                                               | `SESSION_TTL_SECONDS`                     |
| Tentatives de traitement                   | 8, backoff exponentiel depuis 2 s (plafond 1 h)                                      | `JOB_MAX_ATTEMPTS`, `JOB_BACKOFF_BASE_MS` |

Délai d'indexation : de l'ordre de la seconde avec le fournisseur par défaut ; dépend du modèle
sinon. La jauge (§3.1) le montre.

---

## 7. Variables d'environnement

Côté Archipel (voir `.env.example`, complet et commenté) :

| Variable                                                                       | Obligatoire   | Défaut        | Sens                                                               |
| ------------------------------------------------------------------------------ | ------------- | ------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`                                                                 | oui           | (compose)     | Connexion Postgres du rôle `archipel_app`.                         |
| `ARCHIPEL_HMAC_SECRET`                                                         | oui           | —             | Secret HMAC partagé avec Orqea (≥ 32).                             |
| `ARCHIPEL_HANDOFF_SECRET`                                                      | oui           | —             | Secret des jetons de passation, partagé avec Orqea (≥ 32, ≠ HMAC). |
| `ARCHIPEL_SESSION_SECRET`                                                      | oui           | —             | Secret des cookies de session, propre à Archipel (≥ 32).           |
| `POSTGRES_PASSWORD`, `ARCHIPEL_DB_PASSWORD`                                    | oui (compose) | —             | Mots de passe Postgres.                                            |
| `ARCHIPEL_PORT` / `POSTGRES_PORT`                                              | non           | 8080 / 5433   | Ports publiés sur 127.0.0.1.                                       |
| `HOST`, `PORT`                                                                 | non           | 0.0.0.0, 8080 | Écoute HTTP dans le conteneur.                                     |
| `WORKER_HEALTH_PORT`                                                           | non           | 8081          | Healthcheck du worker.                                             |
| `LOG_LEVEL`                                                                    | non           | info          | `fatal`…`debug`, `silent`.                                         |
| `AI_PROVIDER`                                                                  | non           | fake          | `fake` (local, sans clé) ou `openai` (compatible OpenAI).          |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBED_MODEL`, `OPENAI_CHAT_MODEL` | si `openai`   | —             | Point d'accès du modèle.                                           |
| `MAX_EVENT_BYTES`, `RATE_LIMIT_PER_MINUTE`, `SIGNATURE_WINDOW_SECONDS`         | non           | voir §6       | Limites.                                                           |
| `SESSION_TTL_SECONDS`, `COOKIE_SECURE`                                         | non           | 1800, false   | Session UI. Mettre `COOKIE_SECURE=true` derrière HTTPS.            |
| `WORKER_POLL_MS`, `JOB_MAX_ATTEMPTS`, `JOB_BACKOFF_BASE_MS`                    | non           | 500, 8, 2000  | File.                                                              |

Côté Orqea (à ajouter) : `ARCHIPEL_URL` (URL interne de l'API, ex. `http://archipel-api:8080`),
`ARCHIPEL_PUBLIC_URL` (URL vue par le navigateur, ex. `http://127.0.0.1:8080`),
`ARCHIPEL_HMAC_SECRET`, `ARCHIPEL_HANDOFF_SECRET` (mêmes valeurs qu'Archipel).

Changer de modèle d'embeddings (`AI_PROVIDER`, `OPENAI_EMBED_MODEL`) rend les passages existants
invisibles pour la recherche : rejouer les événements des boards (ou `retry`) pour les réindexer.

---

## 8. Brancher Archipel dans le docker compose d'Orqea

Archipel se lance avec son propre `compose.yaml` (Postgres, API, worker). Pour qu'Orqea le joigne
par le réseau Docker, soit on inclut ses services dans le compose d'Orqea, soit on relie les deux
projets par un réseau externe, par exemple :

```yaml
# compose d'Orqea
services:
  orqea-api:
    environment:
      ARCHIPEL_URL: http://archipel-api-1:8080
      ARCHIPEL_PUBLIC_URL: http://127.0.0.1:8080
    networks: [default, archipel]
networks:
  archipel:
    external: true
    name: archipel_default
```

Seul le port de l'API d'Archipel est publié (sur 127.0.0.1) ; Postgres n'a pas besoin d'être
publié en production (le port 5433 sert aux tests).
