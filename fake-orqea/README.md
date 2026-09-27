# `fake-orqea/` — faux Orqea

Joue le rôle d'Orqea pour prouver Archipel de bout en bout, avec les mêmes secrets que `.env` :

```sh
cp .env.example .env
docker compose up -d --build --wait
npm ci
npm run demo            # DEMO_OPEN=0 npm run demo pour ne pas ouvrir de navigateur
```

La démo :

1. pousse un board réaliste (consignes, cartes, déplacement, commentaire, checklist, comptes rendus
   dont un qui **applique** et un qui **contredit** une consigne, une carte créée puis supprimée) ;
2. écrit des faits comme le ferait un agent ;
3. pousse un second board avec les mêmes noms d'entités et un mot de code, puis vérifie qu'il ne
   fuit pas dans le premier ;
4. attend l'indexation (jauge à 100 %) et interroge la mémoire comme un agent (avec budget) ;
5. supprime le second board et affiche les comptes avant/après ;
6. ouvre l'UI par une passation (lien valable 60 s, à usage unique).

- `client.ts` : signature HMAC des appels et fabrication du lien de passation — exactement ce
  qu'Orqea devra faire.
- `board.ts` : les données de démonstration.
- `demo.ts` : le scénario.
