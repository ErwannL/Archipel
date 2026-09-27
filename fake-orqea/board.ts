/** A realistic demo board: an e-commerce team reworking its checkout. */

type Ev = { type: string; data: Record<string, unknown> };

export const PEOPLE = {
  alice: { authorId: 'u-alice', authorName: 'Alice Martin' },
  bruno: { authorId: 'u-bruno', authorName: 'Bruno Lefèvre' },
  chloe: { authorId: 'u-chloe', authorName: 'Chloé Dubois' },
};

export const GUIDELINES = `# Consignes du board « Refonte paiement »

## Paiements
Tous les paiements passent par le module \`PaymentGateway\`. Aucun appel direct à l'API \`Stripe\`
depuis le front ou depuis un autre service.

## Données personnelles
Ne jamais journaliser un numéro de carte, un email ou une adresse. Les logs contiennent des ids.

## Base de données
Toute migration de la table \`orders\` passe par une revue et un script de retour arrière.
`;

export function demoEvents(): Ev[] {
  return [
    {
      type: 'doc.created',
      data: { docId: 'regles-paiement', title: 'Consignes', markdown: GUIDELINES, ...PEOPLE.alice },
    },
    {
      type: 'card.created',
      data: {
        cardId: 'c-101',
        title: 'Refonte du tunnel de paiement',
        listName: 'En cours',
        labels: ['checkout', 'prioritaire'],
        description:
          'Le service `Checkout` dépend de `PaymentGateway`. Objectif : réduire les abandons de panier de 15 %.\n\nDécision : on garde 3 étapes maximum.',
        ...PEOPLE.alice,
      },
    },
    {
      type: 'comment.created',
      data: {
        commentId: 'm-1',
        cardId: 'c-101',
        text: '@bruno peux-tu vérifier que `PaymentGateway` gère le 3-D Secure ? #securite',
        ...PEOPLE.alice,
      },
    },
    {
      type: 'checklist.created',
      data: {
        checklistId: 'k-1',
        cardId: 'c-101',
        title: 'Mise en production',
        items: [
          { text: 'Tests de charge sur `PaymentGateway`', done: true },
          { text: 'Revue sécurité', done: false },
        ],
        ...PEOPLE.bruno,
      },
    },
    {
      type: 'report.created',
      data: {
        reportId: 'r-1',
        cardId: 'c-101',
        agentId: 'agent-dev',
        text: 'Compte rendu : conformément à la consigne, tous les paiements passent par le module `PaymentGateway`.\nDécidé : `Checkout` utilise `PaymentGateway` pour le 3-D Secure.',
        ...PEOPLE.bruno,
      },
    },
    {
      type: 'card.created',
      data: {
        cardId: 'c-102',
        title: 'Bug : double débit sur mobile',
        listName: 'À faire',
        labels: ['bug'],
        description:
          'Bug : double débit quand l’utilisateur tape deux fois sur Payer. Touche `Checkout` et `PaymentGateway`.',
        ...PEOPLE.chloe,
      },
    },
    {
      type: 'report.created',
      data: {
        reportId: 'r-2',
        cardId: 'c-102',
        agentId: 'agent-dev',
        text: 'Correctif temporaire : contrairement à la consigne, le front appelle directement l’API `Stripe` pour vérifier le statut du paiement.',
        ...PEOPLE.chloe,
      },
    },
    {
      type: 'card.created',
      data: {
        cardId: 'c-103',
        title: 'Migration table orders',
        listName: 'À faire',
        description:
          'Ajouter la colonne `currency` à la table `orders`. Le module `Reporting` dépend de `orders`.',
        ...PEOPLE.bruno,
      },
    },
    {
      type: 'card.moved',
      data: {
        cardId: 'c-101',
        title: 'Refonte du tunnel de paiement',
        listName: 'En revue',
        labels: ['checkout'],
        description:
          'Le service `Checkout` dépend de `PaymentGateway`.\n\nDécision : on garde 3 étapes maximum.',
        ...PEOPLE.alice,
      },
    },
    {
      type: 'card.created',
      data: {
        cardId: 'c-199',
        title: 'Carte créée par erreur',
        description: 'Le module `Brouillon` dépend de `Poubelle`.',
        ...PEOPLE.chloe,
      },
    },
    { type: 'card.deleted', data: { cardId: 'c-199' } },
  ];
}

/** Another board of the same team: same names, different facts. Must never leak. */
export function otherBoardEvents(): Ev[] {
  return [
    {
      type: 'card.created',
      data: {
        cardId: 'c-1',
        title: 'Audit confidentiel',
        listName: 'Secret',
        description:
          'Le module `PaymentGateway` dépend de `Zanzibar`. Mot de code : ornithorynque.',
        ...PEOPLE.alice,
      },
    },
  ];
}

export const AGENT_FACTS = [
  {
    factId: 'f-1',
    text: 'Décidé : le module `PaymentGateway` dépend de `Stripe` via un adaptateur.',
  },
  { factId: 'f-2', text: 'Le service `Checkout` remplace `LegacyCart`.' },
];
