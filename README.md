# Révision rapide WaniKani

Petite web app statique pour réviser rapidement vos radicaux, kanji et vocabulaire WaniKani.
Chaque élément s'affiche avec le caractère japonais à gauche ; le **sens** et la **lecture** sont masqués et
s'affichent en un clic sur la carte (un second clic les masque à nouveau).

## Fonctionnement

- **Authentification** : vous saisissez votre jeton d'API WaniKani (*Settings → API Tokens*). Un jeton en lecture seule suffit.
- **Stockage** : le jeton est conservé dans le `localStorage` de votre navigateur. Il n'est jamais écrit dans le code
  ni envoyé ailleurs qu'à `api.wanikani.com`. Le bouton *Changer de jeton* l'efface.
- **Filtres** : types (radicaux, kanji, vocabulaire), plage de niveaux, statut
  (tous, déjà commencés, à réviser maintenant). Les filtres sont mémorisés dans le navigateur.
- **Actions** : *Mélanger* pour l'ordre aléatoire, *Tout afficher* / *Tout masquer*.

Aucune dépendance ni étape de build : ce sont trois fichiers (`index.html`, `styles.css`, `app.js`).

## Lancer en local

Ouvrez `index.html` dans le navigateur, ou depuis le dossier du projet :

```bash
python3 -m http.server 8000
```

puis rendez-vous sur <http://localhost:8000>.

## Publication sur GitHub Pages

Le workflow `.github/workflows/pages.yml` publie le site à chaque push sur la branche `claude/sharp-ritchie-oti2be` (ou `main`).

Réglage à faire une seule fois dans GitHub :

1. *Settings → Pages*
2. Dans *Build and deployment → Source*, choisissez **GitHub Actions**.

L'app sera ensuite disponible à l'adresse `https://maxme.github.io/wanikani-quick-review/`.

## Limites connues

- Les radicaux sans caractère (image seule) sont affichés via leur image WaniKani.
- Le filtre « À réviser maintenant » se base sur `available_at` renvoyé par l'API ; il reflète l'état au moment du chargement.
- Limite de l'API WaniKani : 60 requêtes par minute. Une liste très large peut en demander plusieurs pages ; en cas de dépassement, un message l'indique.
