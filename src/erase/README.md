# `src/erase/` — effacement d'un utilisateur

`eraseUser()` parcourt toutes les îles (chacune dans sa propre transaction isolée), supprime la
mémoire dérivée des contributions de l'utilisateur (items dont il est l'auteur, et tout ce qui en
dérive), anonymise son entité « personne » si d'autres sources la citent encore, et enregistre
l'effacement pour ignorer les événements en retard. Rien n'est supprimé dans Orqea.
