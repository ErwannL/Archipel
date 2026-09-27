# `docker/` — Postgres

`postgres-init.sh` s'exécute une seule fois à la création du volume, en superutilisateur :
crée le rôle applicatif `archipel_app` (**CREATEROLE, pas superutilisateur**), les bases `archipel`
et `archipel_test`, et l'extension `vector`. Il retire à `PUBLIC` les droits de connexion et de
création, pour que les rôles d'île n'aient accès qu'à leur propre schéma.
