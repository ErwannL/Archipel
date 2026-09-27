# Passation : brancher Archipel dans Orqea

Ce document s'adresse à la session qui connaît Orqea et fera le branchement. Archipel a été
construit **sans accès à Orqea** : tout ce qui suit est ce qui a été supposé, et ce qu'il reste à
faire côté Orqea. Le contrat exact est dans [`CONTRACT.md`](CONTRACT.md).

## Ce qui est fait (et vérifié)

- API de service signée HMAC (horodatage + nonce à usage unique) : ingestion d'événements, statut
  par carte et par board, requête GraphRAG avec budget et citations, faits écrits par les agents,
  suppression d'un board avec comptes avant/après, effacement d'un utilisateur, reprise des échecs.
- Une île par board : schéma Postgres + rôle Postgres dédiés ; isolation prouvée par des tests sur
  le vrai Postgres (une île ne peut pas lire une autre île).
- Traitement asynchrone (file Postgres, worker, reprises), jauge `pending | processing | indexed |
failed`.
- UI humaine (graphe, recherche, détail d'entité et sources, état des cartes) ouverte par un jeton
  de passation dans le fragment d'URL.
- Fournisseur de modèle interchangeable : faux déterministe par défaut (aucune clé, aucune donnée
  sortante), adaptateur compatible OpenAI/Ollama en option.
- `docker compose up` (Postgres pgvector, API, worker ; healthchecks ; 127.0.0.1 seulement) ;
  CI GitHub Actions (règles du dépôt, formatage, lint, types, tests à 100 % par fichier sur
  Postgres, build, stack Docker complète + démo de bout en bout) ; faux Orqea (`npm run demo`).

## Hypothèses sur Orqea (à vérifier / adapter)

| Hypothèse                                                                                                                                                   | Si c'est faux                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaque objet (carte, commentaire, checklist, compte rendu, document de consignes) a un id stable et un `updatedAt` (ms) qui augmente à chaque modification. | Utiliser n'importe quel compteur croissant par objet comme `version`. Sans cela, envoyer `Date.now()` au moment de l'émission (acceptable si les émissions d'un même objet sont ordonnées). |
| Les ids MySQL sont numériques.                                                                                                                              | Les envoyer en **chaîne** (`String(id)`).                                                                                                                                                   |
| Un « compte rendu d'agent » est un objet distinct du commentaire, rattaché à une carte.                                                                     | Si c'est un commentaire écrit par un agent, l'envoyer en `report.*` quand l'auteur est un agent (le lien aux consignes se fait pour tous les types de toute façon).                         |
| Les consignes de board sont des documents Markdown avec un id. Les consignes **de profil** ne font pas partie de la mémoire du board.                       | Si des consignes de profil doivent compter, les envoyer comme `doc.*` dans chaque board concerné (jamais partagées entre îles).                                                             |
| Les pièces jointes ne sont pas ingérées (seulement leur existence éventuelle dans la description).                                                          | Pour les indexer, extraire leur texte côté Orqea et l'envoyer comme `comment.*` ou `doc.*`.                                                                                                 |
| Un utilisateur qui voit un board peut voir toute sa mémoire.                                                                                                | Sinon, filtrer avant de fabriquer le lien de passation : Archipel ne gère pas de droits plus fins que le board.                                                                             |

## Ce qu'il reste à faire côté Orqea

1. **Configuration** : ajouter `ARCHIPEL_URL`, `ARCHIPEL_PUBLIC_URL`, `ARCHIPEL_HMAC_SECRET`,
   `ARCHIPEL_HANDOFF_SECRET` (mêmes valeurs que dans le `.env` d'Archipel) et relier les réseaux
   Docker (CONTRACT §8).
2. **Client signé** : copier `archipelCall` (CONTRACT §1) ou `fake-orqea/client.ts`.
3. **Émission d'événements** : après chaque écriture réussie en base, émettre l'instantané de
   l'objet (CONTRACT §2) : création, modification, **déplacement** (`card.moved` avec le nouveau
   `listName`), suppression de carte, commentaire, checklist, compte rendu d'agent, document de
   consignes du board ; `board.deleted` à la suppression d'un board. Recommandé : une petite table
   « outbox » dans MySQL écrite dans la même transaction, vidée par lots de ≤ 100 vers
   `POST /v1/events` avec reprises (les événements sont idempotents, rejouer est sans risque).
4. **Reprise initiale** : pour les boards existants, parcourir leurs objets et envoyer les
   événements `*.created` (lots de 100). Rejouable à volonté.
5. **Agents** : avant d'exécuter une carte, appeler `POST /v1/boards/:boardId/query` avec la
   question (titre + description de la carte, ou la demande de l'agent), `cardId`, et un
   `maxTokens` adapté à la fenêtre de l'agent ; insérer passages et graphe dans le contexte, avec
   consigne de citer `cardId`/`docId`. Donner à l'agent un outil « mémoriser » qui appelle
   `POST /v1/boards/:boardId/facts` (avec `factId` stable, `cardId`, `agentId`, et `authorId` = la
   personne pour qui l'agent travaille).
6. **Jauge sur les cartes** : `GET /v1/boards/:boardId/status` (une requête pour tout le board,
   à mettre en cache quelques secondes) → icône par carte (`indexed` ✓, `pending`/`processing`
   ⏳, `failed` ⚠) et progression du board.
7. **Bouton « Mémoire »** : vérifier l'accès de l'utilisateur au board, signer un JWT de passation
   (CONTRACT §4) et ouvrir `ARCHIPEL_PUBLIC_URL/#handoff=<jwt>` dans un nouvel onglet.
8. **RGPD** : à la suppression d'un compte, appeler `POST /v1/users/:userId/erase` ; à la
   suppression d'un board, émettre `board.deleted` (ou `DELETE /v1/boards/:boardId`) et conserver
   la réponse (comptes avant/après) comme preuve si besoin.
9. **Production** : HTTPS devant Archipel et `COOKIE_SECURE=true` ; générer des secrets forts ;
   ne pas publier le port Postgres ; sauvegarder le volume `pgdata` selon la politique de
   rétention (voir `PRIVACY.md`).

## Points d'attention

- Horloges : la signature tolère ±5 min ; synchroniser les hôtes (NTP).
- Débit : 1200 requêtes/min/board par défaut (`RATE_LIMIT_PER_MINUTE`) ; grouper les événements
  par lots.
- Qualité d'extraction : le fournisseur par défaut est à base de règles (voir
  `src/ai/README.md`), conçu pour être déterministe et hors ligne. Pour une extraction riche en
  production, `AI_PROVIDER=openai` avec OpenAI ou un Ollama local ; puis rejouer les événements
  pour réindexer.
- L'UI affiche les ids Orqea des cartes et documents ; un lien direct vers la carte dans Orqea
  n'est pas fait (il faudrait connaître le format d'URL d'Orqea : ajout simple dans
  `web/src/views.ts`, fonction `citation`).
