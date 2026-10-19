# opencode-delegate

Mod Claude Code qui utilise **opencode 2** comme sous-agent.

## Ce que ça fait

- Sonde `opencode --version` au démarrage de la session et n'enregistre l'outil
  que si opencode est en 2.x. Sans ça, rien n'est proposé à Claude.
- Enregistre un outil `mcp__opencode-delegate__delegate` que Claude peut appeler
  comme un `Task`, avec `prompt`, `writeFiles`, `model`, `agent`, `dir`,
  `resume`, `budgetMs`.
- Lance `opencode run --format json -m <model>` via
  `$.process.run` (plus `--session <id>` sur un `resume`), en `--agent plan`
  (lecture seule) par défaut, et seulement
  avec `--auto` quand l'utilisateur vient d'autoriser l'écriture. En v2,
  `opencode run` parle au **service de fond** : pas de cold start à chaque tâche.
- Pendant le run, un timer interroge `opencode api session.get` toutes les 2 s
  pour remonter coût, tokens et titre dans le pane.
- `/opencode` ouvre le pane : choix du modèle, liste des tâches, totaux.
- Annonce la capacité aux agents dans le contexte du premier message, pour que
  Claude y pense sans qu'on ait à le lui rappeler.
- Rend à Claude la réponse finale d'opencode + l'id de session, à repasser dans
  `resume` pour un suivi sur la même conversation opencode.
- Nomme dans chaque résultat **où et sur quoi** la tâche a tourné : répertoire
  effectif, commit de départ, état du checkout, et un avertissement quand le
  checkout est en retard sur son amont.
- Quand la tâche s'arrête sans conclure, **dit pourquoi**, rend quand même ce
  qu'opencode avait déjà produit, et rend l'id de session pour reprendre par
  `resume` : voir [Quand la tâche s'arrête mal](#quand-la-tâche-sarrête-mal).

## Le pane

```
Modele  opencode/glm-5.3-flash-free

Autre   provider/model (458 au catalogue)

En cours 1 ⌄
╭──────────────────────────────────────────╮
│ Parité clés i18n fr/en apps/mobile  6m02 │
│ glm-5.3-flash-free  12.4k tokens         │
│ 15 appels · 2 reprises · 1 coupure ⌄     │
│   read taxonomy.ts                  420ms│
│   grep (error)                         3s│
╰──────────────────────────────────────────╯

Terminees 3 ›

4 taches · $0.0043
```

Une carte par **session opencode**, pas par appel : une reprise avec `resume`
repasse la même carte en « En cours » et lui ajoute un segment, au lieu d'en
créer une seconde au même titre. Trois lignes, sur le modèle du panneau
« tâches en arrière-plan » de Claude Code : le titre de la session et sa durée
cumulée, rien d'autre : le budget restant ne faisait qu'inquiéter pour rien,
puisqu'une coupure se reprend par `resume` ; le modèle et les tokens consommés sur toute la session ; puis le
nombre d'appels d'outils, dépliable pour voir chacun avec sa durée. Le début du
prompt n'est jamais affiché — c'est du transcript, illisible en une ligne ;
tant qu'opencode n'a pas nommé sa session, le modèle prend la place du titre.
La seconde ligne ne mentionne `ecriture` que lorsque l'écriture a été
autorisée, la lecture seule étant le défaut, et la cause d'arrêt seulement
quand il y en a une. La troisième compte les reprises et les coupures, pour
qu'une session recousue garde la trace de ce qui l'a interrompue. Ni bordure colorée ni glyphe : la section dit déjà si la tâche
tourne, et le seul état qui doit sauter aux yeux est l'échec — il passe donc
par le titre, en rouge.

Le journal des appels se remplit **pendant** que la tâche tourne : il est relu
dans la session opencode toutes les deux rondes de suivi, parce que le flux de
`opencode run`, lui, n'arrive qu'à la sortie du processus. Un outil qui n'a pas
abouti porte son statut dans son libellé (`grep (error)`).

Une tâche mal arrêtée porte en seconde ligne **la cause** de son arrêt
(`budget`, `abandon`, `fournisseur`, `erreur`, `demarrage`).

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

## Quand la tâche s'arrête mal

`$.process.run` ne streame pas : il lit toute la sortie à la fin. Et quand il
tue le processus — budget épuisé, évènement abandonné — il **rejette sans rien
rendre du tout**. Sept minutes de lecture pouvaient donc se solder par une
ligne d'échec, et, pire, par une ligne d'échec qui ne disait pas *laquelle*.

### La cause est nommée

Cinq causes, qui ne se traitent pas de la même façon. Le résultat rendu à
Claude s'ouvre sur la phrase qui va avec, et la carte du pane porte le mot :

| Carte | Ce qui s'est passé | Ce que le résultat conseille |
| :- | :- | :- |
| `budget` | le processus tournait encore quand `budgetMs` a été atteint | relancer avec un `budgetMs` plus large, ou découper |
| `abandon` | `next.signal` s'est abattu : tour interrompu, ou moteur qui a coupé | **ne pas** relancer de soi-même |
| `fournisseur` | une erreur `provider.*` dans le flux (clé, quota, modèle) | régler le fournisseur d'abord : relancer à l'identique redonnera la même erreur |
| `erreur` | opencode s'est arrêté en erreur sur la tâche | lire le détail |
| `demarrage` | la commande n'a pas pu démarrer, ou est morte bien avant son budget | vérifier l'installation, rien n'a tourné |

Les trois premières sont celles qui coûtaient cher à confondre. Elles se
distinguent par deux signaux différents, et non par le message d'erreur :

- **l'abandon**, par `next.signal`, l'`AbortSignal` du hook, qui s'abat quand
  l'évènement est abandonné ;
- **le budget**, par un `$.clock.after(budgetMs)` armé avant le lancement : s'il
  s'est déclenché avant que `$.process.run` rejette, c'est que le processus a
  tenu jusqu'au bout. Comparer des `Date.now()` n'aurait pas suffi — une
  commande qui refuse de démarrer rejette aussi, et c'est un tout autre
  diagnostic.

### La sortie partielle est rendue quand même

Le flux est perdu, mais **la session d'opencode a tout gardé** : tuer le CLI
`opencode run` ne tue pas la session côté service de fond. Le mod retrouve donc
la session (`opencode api session.list`, comme pour le suivi live) et la relit
par `opencode api session.message.list --param sessionID=<id>` pour en sortir :

- le **dernier texte** produit par l'assistant, rendu tel quel à Claude ;
- le **journal des outils** appelés, dans l'ordre, avec leur statut quand il
  n'est pas `completed` — le minimum utile quand il n'y a pas de texte ;
- la **dernière erreur** enregistrée par la session, s'il y en a une.

La forme de cette réponse n'est pas celle de `session.get` : c'est
`{ data: [messages] }`, **du plus récent au plus ancien** ; un message `idle`
porte `outcome` et, en cas d'échec, `error` ; un message `assistant` porte
`content`, où une part de texte est `{ type: 'text', text }` et une part d'outil
`{ type: 'tool', name, state: { status } }` — `name`, et non `tool` comme dans
le flux NDJSON. Les messages arrivent à l'envers du temps mais les parts d'un
message sont dans l'ordre, d'où le regroupement par message avant inversion :
sans ça le journal d'outils se lit à l'envers.

Quand la session ne garde aucun texte, le résultat le dit, au lieu de laisser
croire qu'opencode n'a rien trouvé.

### Et comment reprendre

Un échec rend l'**id de session opencode** et dit explicitement que `resume` le
reprend. Ça a l'air secondaire, c'est ce qui change le plus : le plafond de dix
minutes porte sur **un appel** de `$.process.run`, pas sur une tâche. La session
opencode garde tout son historique, donc une tâche longue se mène en plusieurs
reprises — à condition que Claude ait l'id. Sans lui, la chaîne casse à la
première coupure et le mod a l'air incapable de tenir une tâche longue, alors
qu'il attendait juste qu'on lui repasse l'id.

Quand la session n'a **pas** été retrouvée, le résultat le dit aussi, plutôt que
de laisser croire à une reprise possible : il n'y a alors rien d'autre à faire
que relancer depuis le début. Les deux cas sont verrouillés par un test.

**Cas particulier de l'abandon :** un tour abandonné a déjà repris sans nous, et
le résultat de l'outil ne va plus nulle part. Le texte retrouvé est donc aussi
recopié dans le transcript par `$.ui.log` — la seule voie qui reste pour rendre
à l'utilisateur ce qu'il a payé.

### Où et sur quoi la tâche a tourné

Chaque résultat, succès compris, se termine par une ligne du genre :

```
ou: /Users/paul/projet @ 4bf7906ab12c (main) checkout sale
```

Le répertoire **effectif** (obtenu par un `pwd` dans le `cwd` visé, ce qui
résout un `dir` relatif), le commit de départ, la branche, et l'état sale du
checkout. Quand le checkout est en retard sur son amont, une seconde ligne le
dit et invite à pondérer la conclusion.

C'est le correctif d'un cas réel : un agent a conclu de travers parce
qu'opencode lisait un checkout en retard, sans que personne puisse s'en
apercevoir. Attention, `git rev-list --count HEAD..@{upstream}` mesure le retard
sur l'amont **tel que le dernier `fetch` l'a laissé**, pas sur le dépôt distant
maintenant : le mod ne fetche pas tout seul.
## Permissions

Toute délégation part en **lecture seule** : `--agent plan`, l'agent read-only
d'opencode, et pas de `--auto`. opencode lit le dépôt et rend un compte rendu.
C'est le mode le plus sûr qui reste utile, et c'est celui que Claude obtient
sans rien demander.

Pour qu'une délégation écrive, deux conditions doivent être réunies : Claude
passe `writeFiles: true`, **et** l'utilisateur a armé l'écriture avec
l'interrupteur du pane `/opencode`. Si l'une manque, rien ne s'exécute et
l'outil le dit à Claude, qui peut relancer sans `writeFiles`.

| État | Ce qui part |
| :- | :- |
| `writeFiles` absent | `--agent plan`, sans `--auto`, quel que soit l'interrupteur |
| `writeFiles: true`, écriture désarmée | **rien** ; le pane s'ouvre et le résultat dit quoi faire |
| `writeFiles: true`, écriture armée | `opencode run --auto`, avec l'`agent` demandé s'il y en a un |

En lecture seule, l'argument `agent` est **ignoré** et `plan` est imposé : sans
ça, un `agent: 'build'` choisi par Claude rouvrirait l'écriture par la porte de
derrière. L'`agent` n'est honoré qu'une fois l'écriture armée.

Le pied de page rendu à Claude et la carte du pane nomment le mode retenu, pour
qu'une tâche dégradée en lecture seule ne passe pas pour une tâche qui a écrit.

### Pourquoi un interrupteur, et pourquoi il se désarme

Pourquoi un point de contrôle tout court : opencode tourne avec `--auto`, donc
il approuve lui-même ce qu'il fait, dans un sous-processus. Ses écritures ne
passent ni par le mode auto de Claude Code, ni par les règles de permission, ni
par le classificateur. L'interrupteur est le seul endroit où une personne
décide.

Pourquoi pas l'argument d'outil seul : `writeFiles: true` ferait du modèle
l'autorité, et un mod public installé par n'importe qui écrirait dans le dépôt
sans que personne ait rien dit. L'argument survit comme **signal** — il dit que
la tâche a besoin d'écrire — il n'autorise rien.

Pourquoi pas une question à chaque délégation : c'est ce que faisait le mod
avant, par `$.ui.ask`. L'autorisation était alors la plus précise possible, mais
la friction retombait sur chaque appel, et le moteur ne tenant qu'une question à
la fois, deux délégations en écriture dans le même tour faisaient revenir la
seconde en faux refus.

L'interrupteur vit **dans le module du mod, pas dans `$.store`**, et c'est
délibéré : le stocker le garderait armé d'une session à l'autre et d'un dépôt à
l'autre, et une case cochée un mardi autoriserait les écritures du mercredi
ailleurs. Au niveau module, il se remet à zéro à chaque session Claude Code, et
à chaque rechargement du mod — une mise à jour du plugin, un `/reload-plugins`.
Un `/clear` ne le désarme pas : le module reste chargé, et son état reste
visible dans le pane.

Le coût de ce choix est qu'une délégation en écriture lancée alors que
l'interrupteur est désarmé ne part pas du premier coup.

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
  dix minutes ; le suivi live vient donc du polling, pas du flux. `spawn` est
  apparu dans les `.d.ts` de builds plus récents (`claude-code` 2.1.299) ; le mod
  ne s'en sert pas, pour rester chargeable sur un build qui ne l'a pas. C'est
  l'axe d'amélioration : avec `spawn`, les événements NDJSON se liraient au fil
  de l'eau et la sortie partielle n'aurait plus à être relue dans la session.
- **Pas d'option de worktree jetable.** L'idée était de laisser `dir` accepter
  une référence git (`origin/main`) et de créer un worktree détaché, pour qu'une
  lecture ne dépende jamais de l'état du checkout de l'opérateur. Écartée :
  - un worktree **écrit dans le `.git` de l'opérateur** (`git worktree add`), ce
    qui est une écriture de plus, faite hors de l'interrupteur, et jusque dans
    une délégation annoncée comme en lecture seule ;
  - il faut le **retirer** après, et le mod n'a précisément aucune garantie de
    tourner jusqu'au bout — un tour abandonné laisserait un worktree orphelin
    dans `git worktree list` à chaque fois, et `git worktree prune` ne le
    nettoie qu'une fois le répertoire temporaire disparu ;
  - `origin/main` ne vaut que ce que vaut le dernier `fetch`, donc il faudrait
    aussi fetcher — du réseau, du temps, et un comportement implicite.

  Ce qui restait du besoin, c'est de ne pas conclure de travers sans le savoir :
  d'où la ligne `ou:` et l'avertissement de retard, qui coûtent trois `git` en
  lecture et rien d'autre. Un worktree reste la bonne réponse quand on en veut
  un, mais à la main, et `dir` prend alors son chemin :

  ```bash
  git fetch origin && git worktree add --detach /tmp/ro-main origin/main
  ```
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
  le pane n'y est pas dessiné, donc personne ne peut armer l'interrupteur, et il
  se remet à zéro à chaque session. La lecture seule, elle, marche.
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
- La récupération de sortie partielle suppose que la session a été **retrouvée**
  dans `opencode api session.list`. Quand elle ne l'est pas — plusieurs tâches
  démarrées dans le même répertoire à la même seconde, service de fond muet — il
  n'y a rien à relire et le résultat n'a que la cause de l'arrêt.
- Le cas `abandon` n'est **pas couvert par les tests** : il se reconnaît à
  `next.signal`, et le kit de `claude plugin test` n'a pas de quoi abattre ce
  signal. Les quatre autres causes le sont (`tests/failure.test.ts`).
- Toujours sur l'abandon : la relecture de la session et le `$.ui.log` partent
  **après** que le signal s'est abattu, dans les cinq secondes de grâce du hook.
  Le temps passé dans un appel de `$` ne compte pas dans ce budget, mais si le
  moteur refuse les appels d'un hook dont le tour est parti, il n'y aura rien à
  recopier. Tout est dans des `try`/`catch` : au pire la cause est rendue seule.
- Le retard sur l'amont est mesuré par `git rev-list --count HEAD..@{upstream}`,
  donc **tel que le dernier `fetch` l'a laissé**. Le mod ne fetche pas : un
  checkout jamais fetché depuis des jours passe pour à jour.
- Sonder le checkout coûte quatre commandes (`pwd` et trois `git`) avant chaque
  délégation. C'est de la lecture, et le temps passé dans un appel de `$` ne
  compte pas dans le budget du hook, mais ça rallonge de quelques dizaines de
  millisecondes le départ de chaque tâche.
