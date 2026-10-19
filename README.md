# opencode-delegate

Mod Claude Code qui utilise **opencode 2** comme sous-agent.

## Ce que ça fait

- Enregistre un outil `mcp__opencode-delegate__delegate` que Claude peut appeler
  comme un `Task`, avec `prompt`, `model`, `agent`, `dir`, `resume`, `budgetMs`.
- Lance `opencode run --format json --auto --session <id> -m <model>` via
  `$.process.run`. En v2, `opencode run` parle au **service de fond** : pas de
  cold start à chaque tâche.
- Pendant le run, un timer interroge `opencode api session.get` toutes les 2 s
  pour remonter coût, tokens et titre dans le pane.
- `/opencode` ouvre le pane : choix du modèle, liste des tâches, totaux.
- Annonce la capacité aux agents dans le contexte du premier message, pour que
  Claude y pense sans qu'on ait à le lui rappeler.
- Rend à Claude la réponse finale d'opencode + l'id de session, à repasser dans
  `resume` pour un suivi sur la même conversation opencode.

## Le pane

```
Modele  opencode/glm-5.3-flash-free

Autre   provider/model (457 au catalogue)

▾ En cours (1)
╭────────────────────────────────────────╮
│ ▸ kimi-k2.7-code          1m12  $0.0032│
│ Refactor du module auth                │
╰────────────────────────────────────────╯
▸ Terminees (3)

4 taches · $0.0043
```

Une tâche par carte, bordure colorée selon le statut : bleu en cours, vert
terminé, rouge en échec, toutes de la même épaisseur. Les deux listes se
plient et se déplient en cliquant leur en-tête, ou avec `e` et `t` quand le
pane a le focus. `tests/delegate.test.ts` monte le pane avec
une carte sur les trois surfaces et vérifie que le moteur n'a pas repris la
main, ce qui est le symptôme d'un arbre refusé.

Le sélecteur **Modele** liste les modèles récents d'abord, puis ceux des mêmes
fournisseurs, puis le reste du catalogue d'`opencode models`, chargé en tâche
de fond au démarrage de la session. Le champ **Autre** accepte n'importe quel
`provider/model` et le refuse s'il n'est pas dans ce catalogue, ce qui évite
les fautes de frappe.

La liste est coupée à 64 entrées : **un `Select` n'accepte que 1 à 64 options**,
et au-delà le moteur refuse l'arbre entier et dessine un pane vide à la place.
C'est pour ça que le champ de saisie libre existe : le catalogue d'opencode
compte environ 500 modèles. `tests/surface.test.ts` monte le pane avec un
catalogue de 501 entrées sur les trois surfaces pour que la régression ne
revienne pas.

Le modèle choisi devient celui des délégations suivantes. Il est gardé dans
`$.store`, partagé par toutes les sessions de la machine, donc il survit au
redémarrage. L'argument `model` de l'outil reste prioritaire sur ce choix, et
la variable d'environnement `OPENCODE_DELEGATE_MODEL`, si elle est posée,
l'emporte au démarrage de la session.

## Installation

Le CLI `claude` doit être en 2.1.289 ou plus récent (les mods n'existent pas
avant), et opencode en 2.x, authentifié sur au moins un provider.

```bash
claude plugin install opencode-delegate --marketplace PaulThiberville/opencode-delegate
```

Depuis une session, la même chose en une commande :

```
/plugin install opencode-delegate --marketplace PaulThiberville/opencode-delegate
```

Pour recevoir les versions suivantes :

```bash
claude plugin update opencode-delegate@opencode-delegate
```

Vérifier qu'il est chargé : `/plugin` dans une nouvelle session doit afficher
`opencode-delegate`, et `/opencode` doit ouvrir le pane.

> Si une copie du mod traîne dans `~/.claude/skills/opencode-delegate`, la
> retirer avant d'installer depuis le marketplace. Deux plugins du même nom
> chargés ensemble, et c'est l'un qui prend le nom tandis que l'autre ne charge
> pas son module de hooks : le mod a l'air cassé sans raison.

### Développer dessus

```bash
cd ~/un/projet && claude --plugin-dir ~/Documents/Dev-Perso/opencode-delegate
```

```bash
cd ~/Documents/Dev-Perso/opencode-delegate && claude plugin validate . --strict && claude plugin test
```

## Choix d'implémentation

- **`$.process.run` et pas `$.process.spawn`** : le `.d.ts` publié ne déclare
  que `run`. `run` lit toute la sortie à la fin (pas de streaming) et plafonne à
  dix minutes ; le suivi live vient donc du polling, pas du flux. Si `spawn`
  existe dans le build installé, c'est l'axe d'amélioration : on lirait les
  événements NDJSON au fil de l'eau.
- **Session créée par le serveur, pas inventée.** `--session` accepte un id
  inexistant et le crée, ce qui serait le plus simple pour connaître l'id avant
  la fin du run. Mais le palier **gratuit** d'OpenCode Console lit un id qu'il
  n'a pas émis comme un appel « hors d'OpenCode » et répond `403 FreeTierError`
  (« OpenCode's free tier can only be used from within OpenCode »), sur
  `big-pickle`, `glm-5.3-flash-free` et les autres. Le mod appelle donc
  `opencode api session.create` d'abord : id authentique, et on le connaît quand
  même avant le run, donc le suivi live est conservé. Si cette création échoue,
  la tâche part sans `--session` et l'id est lu dans le flux à la fin, au prix
  du suivi live.
- **`opencode api` plutôt que `$.http.fetch`** : l'API v2 est sous `/api` et
  répond 401 sans jeton ; le CLI gère l'auth.
- **Noms d'arguments** (`dir`, `resume`, `budgetMs`) choisis pour ne pas risquer
  de collision avec les champs de l'événement `tool.call`, puisque les arguments
  de l'outil arrivent à plat sur `e`.
- **Pane maison plutôt que sous-agent natif** : faire apparaître la tâche dans
  le panneau « tâches en arrière-plan » demanderait un vrai sous-agent Claude
  qui relaie vers l'outil, soit un tour de modèle en plus par délégation. Le
  pane coûte zéro et montre ce que le panneau natif n'a pas : coût opencode,
  tokens, id de session.

## Limites connues

- `--auto` auto-approuve les permissions d'opencode : il écrit dans le dépôt
  sans demander. Pour de vrai, isoler dans un worktree ou passer les permissions
  dans le pane via `$.ui.ask`.
- Aucun préflight : si opencode est absent ou en 1.x, l'outil est quand même
  proposé au modèle, qui l'appellera et recevra un échec lisible mais inutile.
- Pas de garde-fou contre deux agents qui éditent le même fichier en parallèle.
- Le bloc de contexte qui annonce la capacité aux agents **ne s'exécute pas**
  pour un plugin installé par une personne quand une organisation gère Claude
  Code par managed settings : seuls les plugins listés par l'organisation y ont
  droit. À savoir si le mod part un jour dans l'équipe par ce canal.
- Le pane ne rend rien en `claude -p` ni dans l'Agent SDK.
- `tasks` grandit sans limite sur la durée de la session.
