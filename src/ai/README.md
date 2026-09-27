# `src/ai/` — fournisseur de modèle

`ModelProvider` = `embed(texts)` + `extract(text)`. Deux implémentations :

- `fake.ts` (**par défaut**) : déterministe, hors ligne, sans clé. Embeddings par hachage de mots et
  de trigrammes ; extraction par règles (`@personne`, `` `composant` ``, `module X`, `#notion`,
  `Décidé : …`, `Bug : …`, « X dépend de Y », « X remplace Y », « X utilise Y ») et détection de
  position vis-à-vis des consignes (« conformément à… », « contrairement à… »).
- `openai.ts` : tout point d'accès compatible OpenAI (OpenAI, Ollama, vLLM, Mistral…).

Les erreurs sont des `ModelError` avec un code court (`model_http_503`…), sans contenu.
Chaque embedding est stocké avec l'id du modèle : des vecteurs de modèles différents ne sont jamais
comparés.
