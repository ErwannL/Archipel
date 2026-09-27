# Données personnelles : ce qu'Archipel stocke, combien de temps, comment c'est effacé

Archipel est une **mémoire dérivée** d'Orqea. Orqea reste la source de vérité : Archipel ne
supprime ni ne modifie jamais rien dans Orqea, il n'efface que sa propre mémoire.

## Ce qui est stocké

### Dans l'île d'un board (schéma Postgres `isl_<hash>`, un par board)

| Table                                      | Contenu                                                                                                                                                                                                                                                               | Données personnelles possibles              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `items`                                    | Dernière version connue de chaque élément du board : titre et texte des cartes, commentaires, checklists, comptes rendus d'agents, documents de consignes, faits d'agents ; id Orqea de l'élément et de sa carte ; `author_id`, `author_name` ; statut de traitement. | Oui : textes libres, nom et id de l'auteur. |
| `passages`                                 | Découpage des textes ci-dessus, avec leur embedding (vecteur) et leur index lexical.                                                                                                                                                                                  | Oui (mêmes textes).                         |
| `entities`                                 | Entités extraites : personnes (nom affiché, id Orqea de l'auteur), composants, décisions, bugs, notions.                                                                                                                                                              | Oui : noms de personnes.                    |
| `mentions`, `relations`, `guideline_links` | Liens entre entités et passages, entre entités, entre passages et consignes.                                                                                                                                                                                          | Non (ids internes).                         |
| `tombstones`                               | Id + version des éléments supprimés (pour refuser les événements en retard).                                                                                                                                                                                          | Non (ids seulement).                        |

### Dans le schéma de contrôle (`archipel`, commun)

**Uniquement des identifiants et des horodatages, jamais de contenu :**

| Table              | Contenu                                                  | Durée                                                                                                                    |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `islands`          | `boardId` → nom de schéma.                               | Jusqu'à la suppression du board.                                                                                         |
| `board_tombstones` | `boardId` + version de suppression.                      | Indéfinie (quelques octets par board supprimé ; nécessaire pour refuser un événement en retard qui recréerait le board). |
| `erased_users`     | `userId` + version de l'effacement.                      | Indéfinie (même raison).                                                                                                 |
| `jobs`             | `boardId` + clé d'élément à traiter.                     | Jusqu'au traitement.                                                                                                     |
| `nonces`           | Nonces HMAC déjà vus.                                    | 10 min.                                                                                                                  |
| `used_handoffs`    | Empreinte SHA-256 des jetons de passation déjà utilisés. | 2 min.                                                                                                                   |

### Ailleurs

- **Journaux** : méthode, motif de route (`/v1/boards/:boardId/query`), statut, durée, ids de board
  et d'élément dans les journaux du worker, codes d'erreur. Jamais de texte de carte, de document,
  de question ni de réponse, jamais de chaîne de requête ni de corps, jamais de message d'erreur
  Postgres ou du modèle. La conservation des journaux est celle de Docker (à régler côté
  exploitation).
- **Navigateur** : un cookie de session `archipel_session` (id de board, id d'utilisateur,
  expiration, signés) pendant 30 min. Aucun stockage local.
- **Modèle** : avec le fournisseur par défaut (`AI_PROVIDER=fake`), rien ne sort de la machine.
  Avec `AI_PROVIDER=openai`, les textes des passages et les questions sont envoyés au point
  d'accès configuré (OpenAI, ou un Ollama local si l'on veut que rien ne sorte) : c'est un
  sous-traitant à déclarer.
- **Sauvegardes** : Archipel n'en fait pas. Si l'exploitant sauvegarde le volume Postgres, les
  données effacées y restent jusqu'à l'expiration de la sauvegarde : à prendre en compte dans la
  politique de rétention.

## Combien de temps

Tant que l'élément existe dans Orqea. Archipel ne garde pas d'historique : chaque mise à jour
remplace la précédente (texte, passages, embeddings, entités dérivées). Il n'y a pas de rétention
automatique supplémentaire : la durée est pilotée par les suppressions qu'Orqea envoie.

## Comment c'est effacé

Toutes ces suppressions sont **réelles** (`DELETE` / `DROP`, pas de marquage) et **appliquées avant
la réponse** à Orqea.

| Événement                                                                                                        | Effet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Élément supprimé (`comment.deleted`, `checklist.deleted`, `report.deleted`, `doc.deleted`, `DELETE …/facts/:id`) | L'item, ses passages et embeddings, ses mentions, relations et liens disparaissent (clés étrangères en cascade) ; puis toute entité qui n'a plus **aucune** source est supprimée. Pour un document de consignes, les liens vers les consignes sont recalculés.                                                                                                                                                                                                                                                                  |
| Carte supprimée (`card.deleted`)                                                                                 | Idem pour la carte **et tout ce qui y est rattaché** (commentaires, checklists, comptes rendus, faits d'agents).                                                                                                                                                                                                                                                                                                                                                                                                                |
| Board supprimé (`board.deleted` ou `DELETE /v1/boards/:boardId`)                                                 | `DROP SCHEMA … CASCADE` de l'île (toutes ses tables), `DROP ROLE`, suppression de ses jobs et de son entrée au registre. La réponse donne les comptes **avant et après** (tous à zéro) ; `GET /v1/boards/:boardId/stats` permet de le revérifier à tout moment.                                                                                                                                                                                                                                                                 |
| Compte supprimé (`POST /v1/users/:userId/erase`)                                                                 | Dans toutes les îles : suppression de la mémoire issue de tout ce dont l'utilisateur est l'auteur (et de tout ce qui en dérive), suppression des entités devenues orphelines, anonymisation (« Utilisateur effacé », id retiré) de son entité « personne » si d'autres sources la citent encore. Les éléments écrits par d'autres ne sont pas supprimés, même s'ils le mentionnent : c'est le contenu d'autres personnes, qui vit dans Orqea ; s'ils y sont modifiés ou supprimés, Archipel suit. La réponse donne les comptes. |

Espace disque : Postgres récupère l'espace des lignes supprimées par `autovacuum` ; un `DROP
SCHEMA` libère immédiatement les fichiers des tables de l'île.

## Isolation

Aucune donnée, aucun index, aucun cache et aucun embedding n'est partagé entre deux boards, même
pour un même utilisateur ou une entité de même nom : chaque île est un schéma distinct, lisible
uniquement par son propre rôle Postgres (voir `docs/DECISIONS.md` §1 et
`test/isolation.test.ts`). La session de l'UI est limitée à un seul board.
