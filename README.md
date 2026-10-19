# opencode-delegate

Mod Claude Code qui utilise **opencode 2** comme sous-agent.

## Ce que ça fait

- Sonde `opencode --version` au démarrage de la session et n'enregistre l'outil
  que si opencode est en 2.x. Sans ça, rien n'est proposé à Claude.
- Enregistre un outil `mcp__opencode-delegate__delegate` que Claude peut appeler
  comme un `Task`, avec `prompt`, `writeFiles`, `model`, `agent`, `dir`,
  `resume`, `budgetMs`.
- Lance `opencode run --format json --session <id> -m <model>` via
  `$.process.run`, en `--agent plan` (lecture seule) par défaut, et seulement
  avec `--auto` quand l'utilisateur vient d'autoriser l'écriture. En v2,
  `opencode run` parle au **service de fond** : pas de cold start à chaque tâche.
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

En cours 1 ⌄
╭────────────────────────────────────────╮
│ Refactor du module auth           1m12 │
│ ▸ kimi-k2.7-code  ecriture  $0.0032    │
╰────────────────────────────────────────╯

Terminees 3 ›

4 taches · $0.0043
```

Une tâche par carte, calquée sur le panneau « tâches en arrière-plan » de
Claude Code : le titre qu'opencode a donné à sa session et la durée sur la
première ligne, puis le modèle, la portée (`lecture` ou `ecriture`) et le coût
en seconde ligne, estompés. Le début du prompt n'est jamais affiché — c'est du
transcript, illisible en une ligne ; tant qu'opencode n'a pas nommé sa session,
le modèle prend la place du titre. La bordure est neutre : le statut tient dans
le glyphe, seul signe qui distingue un échec d'une réussite parmi les terminées,
et dans la section qui porte la carte.

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

## Préflight

`session.start` lance `opencode --version` (`$.process.run`, 5 s de budget,
try/catch parce que l'appel **rejette** si le binaire ne démarre pas) et lit le
numéro de version. Si opencode manque, répond en erreur, ou est en 1.x :

- l'outil **n'est pas enregistré** ;
- le bloc `prompt.context` qui annonce la capacité n'est pas ajouté, sinon on
  promettrait à Claude un outil qui n'existe pas ;
- une ligne `$.ui.log` dit une fois ce qui manque et quoi faire ;
- le catalogue `opencode models` n'est pas chargé ;
- `/opencode` reste enregistrée, et son pane explique la situation au lieu
  d'afficher un sélecteur de modèle et une liste vide trompeuse.

Le préflight bloque le premier prompt, donc son budget est court. Il tourne une
fois par session : une installation d'opencode faite en cours de session n'est
vue qu'à la session suivante.

## Permissions

Toute délégation part en **lecture seule** : `--agent plan`, l'agent read-only
d'opencode, et pas de `--auto`. opencode lit le dépôt et rend un compte rendu.
C'est le mode le plus sûr qui reste utile, et c'est celui que Claude obtient
sans rien demander.

Pour une tâche qui doit écrire, Claude passe `writeFiles: true`. Le mod demande
alors à l'utilisateur, par `$.ui.ask`, s'il laisse opencode écrire, en nommant la
tâche et le répertoire. Trois réponses :

| Réponse | Ce qui part |
| :- | :- |
| `Autoriser l'ecriture` | `opencode run --auto`, avec l'`agent` demandé s'il y en a un |
| `Lecture seule` | la tâche tourne en `--agent plan`, sans `--auto` |
| `Annuler`, ou la question écartée | **rien** ne s'exécute |

`$.ui.ask` **rejette** quand la question est écartée et dans un `claude -p`, où
personne ne peut répondre. Dans les deux cas la délégation n'a pas lieu et
l'outil le dit à Claude, qui peut relancer sans `writeFiles`. Une écriture ne
peut donc jamais être la conséquence d'un silence.

En lecture seule, l'argument `agent` est **ignoré** et `plan` est imposé : sans
ça, un `agent: 'build'` choisi par Claude rouvrirait l'écriture par la porte de
derrière. L'`agent` n'est honoré qu'une fois l'écriture autorisée.

Le pied de page rendu à Claude et la carte du pane nomment le mode retenu, pour
qu'une tâche dégradée en lecture seule ne passe pas pour une tâche qui a écrit.

### Pourquoi `$.ui.ask` plutôt qu'un argument d'outil ou un interrupteur de pane

Les trois mécanismes étaient sur la table. `$.ui.ask` gagne parce que c'est le
seul dont l'autorisation vient de l'utilisateur, au moment de l'écriture, pour
cette écriture-là.

- **Un argument d'outil seul** (`writeFiles: true` et on part) ferait du modèle
  l'autorité : Claude s'accorderait la permission qu'il demande, et un mod public
  installé par n'importe qui écrirait dans le dépôt sans que personne ait rien
  dit. L'argument survit, mais comme **signal** : il déclenche la question, il ne
  la remplace pas.
- **Un interrupteur dans le pane** armerait l'écriture une fois, de façon
  invisible au moment des délégations suivantes, et comme le reste des réglages
  du pane il vivrait dans `$.store`, partagé par toutes les sessions de la
  machine : une case cochée un mardi autoriserait les écritures du mercredi dans
  un autre dépôt. L'écriture ne serait plus la conséquence *directe* d'un choix.

Le coût de ce choix est une question par délégation en écriture, et une
délégation en écriture impossible en `claude -p`. Les tâches en lecture seule,
elles, ne demandent rien.

## Installation

Le CLI `claude` doit être en 2.1.289 ou plus récent (les mods n'existent pas
avant), et opencode en **2.x**, authentifié sur au moins un provider. Sans
opencode 2.x, le mod se charge quand même mais n'enregistre pas l'outil : voir
[Préflight](#préflight). Vérifier avec `opencode --version`.

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
- **La session est créée par `opencode run`, pas par l'API.** Deux contraintes
  se contredisent. Le palier **gratuit** d'OpenCode Console lit un id de session
  qu'il n'a pas émis comme un appel « hors d'OpenCode » et répond
  `403 FreeTierError` — donc pas d'id inventé. Mais une session créée par
  `opencode api session.create` se voit imposer le répertoire du **service de
  fond**, celui d'où il a démarré : la tâche lit et écrit là, pas dans le
  projet, et `dir` reste sans effet. Ni un champ `directory` dans le corps, ni
  un paramètre de requête, ni un en-tête ne le changent. Le mod laisse donc
  `opencode run` créer sa session, où le cwd est honoré, puis la retrouve par
  `opencode api session.list` — la plus récente créée après le départ de la
  tâche, dans le répertoire visé — pour alimenter le suivi live. Si elle n'est
  pas retrouvée, la tâche aboutit quand même et l'id est lu dans le flux à la
  fin ; seul le suivi live manque.
- **Une reprise (`resume`) garde le répertoire de la session d'origine**, pas
  celui passé dans `dir` : la session appartient déjà à un projet.
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

- Une délégation en écriture est impossible en `claude -p` et dans l'Agent SDK :
  `$.ui.ask` y rejette, faute de quelqu'un à qui demander. La lecture seule, elle,
  marche.
- En lecture seule, la tâche part **sans** `--auto`. Si une configuration locale
  donne à l'agent `plan` un outil qui demande une approbation, opencode attend
  cette approbation que personne ne lui donnera, et la tâche meurt au timeout.
  C'est le compromis volontaire : plutôt un échec visible qu'un `--auto` qui
  approuverait une écriture.
- La fenêtre d'autorisation porte sur la délégation entière, pas sur chaque
  fichier : une fois l'écriture autorisée, `--auto` approuve tout ce qu'opencode
  fait dans cette tâche. Pour un vrai cloisonnement, isoler dans un worktree.
- Le préflight ne tourne qu'au démarrage de la session : installer opencode
  ensuite demande de relancer la session, ou `/reload-plugins`.
- Pas de garde-fou contre deux agents qui éditent le même fichier en parallèle.
- Le bloc de contexte qui annonce la capacité aux agents **ne s'exécute pas**
  pour un plugin installé par une personne quand une organisation gère Claude
  Code par managed settings : seuls les plugins listés par l'organisation y ont
  droit. À savoir si le mod part un jour dans l'équipe par ce canal.
- Le pane ne rend rien en `claude -p` ni dans l'Agent SDK.
- `tasks` grandit sans limite sur la durée de la session.
