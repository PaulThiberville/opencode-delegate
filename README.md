# opencode-delegate

Mod Claude Code qui utilise **opencode 2** comme sous-agent.

## Ce que ça fait

- Sonde `opencode --version` au démarrage de la session et n'enregistre l'outil
  que si opencode est en 2.x. Sans ça, rien n'est proposé à Claude.
- Enregistre un outil `mcp__opencode-delegate__delegate` que Claude peut appeler
  comme un `Task`, avec `prompt`, `writeFiles`, `model`, `agent`, `dir`,
  `resume`, `budgetMs`, `background`.
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
- Avec `background: true`, rend la main **tout de suite** et ramène le compte
  rendu plus tard, dans un tour à lui, pour que l'orchestrateur reste disponible
  pendant qu'opencode travaille : voir
  [La délégation en arrière-plan](#la-délégation-en-arrière-plan).
- Enregistre un second outil `mcp__opencode-delegate__delegations` qui **regarde**
  ces délégations sans rien relancer : `action: "list"` pour celles de la session,
  `action: "log"` pour le journal de l'une d'elles : voir
  [Voir ses propres délégations](#voir-ses-propres-délégations).
- Accepte un `schema` sur une délégation pour recevoir **des données plutôt qu'un
  paragraphe** — en disant exactement ce que ça garantit, et ce que ça ne garantit
  pas : voir [La sortie en JSON](#la-sortie-en-json).

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
tant qu'opencode n'a pas nommé sa session, le modèle prend la place du titre,
et la seconde ligne ne le répète alors pas. Ce titre vient d'opencode, pas du
mod, qui ne fait que le lire : sa génération échoue par intermittence, surtout
sur les modèles gratuits, donc une carte sans titre n'a rien d'anormal.
La seconde ligne ne mentionne `ecriture` que lorsque l'écriture a été
autorisée, la lecture seule étant le défaut, `fond` pour une délégation lancée
en arrière-plan — dire où son résultat va arriver, puisqu'il ne revient pas à
l'appel —, et la cause d'arrêt seulement quand il y en a une. La troisième compte les reprises et les coupures, pour
qu'une session recousue garde la trace de ce qui l'a interrompue. Ni bordure colorée ni glyphe : la section dit déjà si la tâche
tourne, et le seul état qui doit sauter aux yeux est l'échec — il passe donc
par le titre, en rouge.

Le journal des appels se remplit **pendant** que la tâche tourne : il est relu
dans la session opencode toutes les deux rondes de suivi, parce que le flux de
`opencode run`, lui, n'arrive qu'à la sortie du processus. Un outil qui n'a pas
abouti porte son statut dans son libellé (`grep (error)`).

Une tâche mal arrêtée porte en seconde ligne **la cause** de son arrêt
(`budget`, `abandon`, `fournisseur`, `erreur`, `demarrage`, `rechargement`).

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

Six causes, qui ne se traitent pas de la même façon. Le résultat rendu à
Claude s'ouvre sur la phrase qui va avec, et la carte du pane porte le mot :

| Carte | Ce qui s'est passé | Ce que le résultat conseille |
| :- | :- | :- |
| `budget` | le processus tournait encore quand `budgetMs` a été atteint | relancer avec un `budgetMs` plus large, ou découper |
| `abandon` | `next.signal` s'est abattu : tour interrompu, ou moteur qui a coupé | **ne pas** relancer de soi-même |
| `fournisseur` | une erreur `provider.*` dans le flux (clé, quota, modèle) | régler le fournisseur d'abord : relancer à l'identique redonnera la même erreur |
| `erreur` | opencode s'est arrêté en erreur sur la tâche | lire le détail |
| `demarrage` | la commande n'a pas pu démarrer, ou est morte bien avant son budget | vérifier l'installation, rien n'a tourné |
| `rechargement` | le module a été remplacé pendant une délégation **de fond** : son minuteur est mort avec lui | reprendre par `resume`, le travail a sans doute continué |

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
## La délégation en arrière-plan

Par défaut, l'appel **attend** la fin de la tâche : c'est le bon mode quand
Claude a besoin de la réponse d'opencode pour raisonner dans le même tour. Mais
pendant ce temps l'orchestrateur est bloqué, et l'utilisateur avec lui.

`background: true` renverse ça :

```
delegate({ prompt: "...", background: true })
  → rend la main immédiatement, avec un accusé qui dit de ne pas attendre
  → le travail part dans un $.clock.after(0, …), hors de tout événement
  → la carte du pane vit exactement comme pour une délégation bloquante
  → à la fin, $.prompt.submit() ramène le compte rendu dans un tour à lui
```

Le compte rendu différé est **le même** que celui du mode bloquant : réponse
d'opencode, id de session à repasser dans `resume`, répertoire, commit de départ,
durée, et la cause quand la tâche s'arrête sans conclure. Il arrive précédé d'une
phrase qui dit à Claude que c'est un résultat différé, qu'il n'y a rien à
relancer et que l'outil ne doit pas être rappelé pour cette tâche.

Ce n'est **pas** un changement de défaut, et l'argument s'appelle `background`
plutôt qu'un nom déjà pris : les arguments de l'outil arrivent à plat sur `e`
dans un hook `tool.call`, comme `dir`, `resume` et `budgetMs`.

Trois réserves, et ce que le mod en fait.

### 1. Un rechargement du mod tue les minuteurs

Une mise à jour du plugin, un `/reload-plugins`, une perte du worker de hooks :
le module est remplacé, et `$.clock` « annule ses attentes en cours avec l'ancien
environnement ». Une délégation de fond en vol perdrait donc son minuteur :
personne ne notifierait, et sa carte resterait « en cours » à mentir
indéfiniment.

Le mod ne laisse pas cet état mentir. Au lancement d'un job de fond, il écrit un
**marqueur durable** dans `$.store` — une clé par session Claude, `bg:<id de
session>`, parce que le store est partagé entre toutes les sessions. Le marqueur
suit la tâche : id de session opencode dès qu'elle est retrouvée, état du
checkout, battement toutes les 30 s pour savoir jusqu'à quand la tâche tournait.
Il est effacé dès que la tâche conclut.

`session.start` repasse à chaque chargement du module. Le mod y relit les
marqueurs de **sa** session : ceux qui restent sont des jobs qui tournaient quand
le module est tombé. Pour chacun, il reconstruit une carte dans le pane avec la
cause `rechargement` — jamais « en cours » —, relit la session opencode pour
rendre ce qu'elle avait gardé, et notifie comme une fin normale, avec l'id à
repasser dans `resume`. Passé le budget du job plus deux minutes, il n'ouvre plus
un tour pour en parler (la tâche a pu finir toute seule depuis longtemps) : la
carte et une ligne de transcript suffisent. Au-delà de deux heures, le marqueur
est périmé et jeté sans un mot. Les marqueurs des autres sessions sont laissés
tranquilles, sauf abandon de plus de deux heures, qui fait le ménage.

Ce balayage tourne **dans** le hook de démarrage, avant que l'outil ne soit
enregistré, et pas dans un minuteur : sinon une délégation lancée pendant le
balayage écrirait son marqueur dans la même clé et serait prise pour un orphelin.
C'est arrivé, et un test couvre le cas. Le compte rendu, lui, part hors de
l'événement — notifier attend que la session soit inactive.

**Et le processus `opencode` lancé par `$.process.run` ?** Il n'est pas tué par
le rechargement. Le `.d.ts` publié ne lie la vie de l'enfant au module que pour
`$.process.spawn` (« le déchargement du module tue l'enfant ») ; pour `run`, un
appel one-shot exécuté par l'hôte, il ne dit rien de tel. L'enfant continue donc
jusqu'à son terme ou son budget, côté hôte, mais **sa sortie ne va plus nulle
part** : plus personne ne lit son NDJSON. Le travail n'est pas perdu pour autant
— la session opencode en garde l'historique —, d'où le conseil de reprendre par
`resume` plutôt que de relancer la tâche depuis le début.

### 2. L'écriture est lue à l'appel, jamais au lancement du job

L'interrupteur du pane est lu dans le hook `tool.call`, et le booléen qui en sort
est **figé** dans la spécification du job. Un job différé ne relit jamais
l'interrupteur : sinon une délégation partie en lecture seule se mettrait à
écrire parce que l'utilisateur a armé l'écriture entre l'appel et le lancement
effectif, c'est-à-dire sans avoir rien autorisé pour cette tâche-là.

Le refus, quand `writeFiles: true` arrive sur un interrupteur désarmé, reste donc
immédiat et synchrone, `background` ou pas : rien ne part, et le résultat dit
quoi faire. Deux tests tiennent les deux sens : armer après coup ne débloque
rien, et une tâche de fond partie en lecture seule reste en `--agent plan` sans
`--auto` même si l'interrupteur s'arme pendant qu'elle attend son tour.

Pour la même raison, le répertoire de la session est lu **dans le hook** et non
dans le job : le `.d.ts` prévient qu'« un minuteur qui survit à son hook lit le
répertoire de la session » au moment où il tourne, pas celui de l'appel.

### 3. Plusieurs notifications : un seul tour, groupé

`$.prompt.submit` démarre un tour à lui **une fois la session inactive**, et
résout au démarrage de ce tour, pas à sa fin. Deux délégations de fond qui
finissent presque ensemble enchaîneraient donc deux tours, le second coupant ce
que l'utilisateur vient de commencer après avoir lu le premier.

Le mod groupe : un compte rendu prêt entre dans une file, et une fenêtre de
1,5 s laisse le temps à un voisin de la rejoindre, puis toute la file part dans
**un seul** `$.prompt.submit`, chaque rapport sous un en-tête
`=== délégation n/N ===`. Le drain boucle, donc un job qui finit pendant l'attente
de l'inactivité fera un second tour, groupé de la même façon.

Le choix est pour le groupage et pas pour deux tours parce que les deux comptes
rendus servent le même raisonnement : Claude a besoin de les voir ensemble, et
l'utilisateur d'être interrompu une fois plutôt que deux. Si la notification ne
peut pas entrer (prompt refusé, session qui se ferme), le compte rendu est écrit
dans le transcript par `$.ui.log` — la seule voie qui reste pour rendre ce qui a
été payé.

## Voir ses propres délégations

Depuis que l'arrière-plan existe, Claude pouvait lancer des délégations de fond
puis n'avait plus aucun moyen de savoir ce qui tournait : l'utilisateur voyait le
pane, lui était aveugle. Son équivalent natif est `$.agent.list()`.

`mcp__opencode-delegate__delegations` comble ça. Il ne lance rien, ne paye rien,
et `action: "list"` ne fait **aucun appel de CLI** — tout est déjà en mémoire
dans le mod.

### `action: "list"`

Rend les délégations de la session, la plus récente d'abord : statut, modèle, id
de session opencode, durée, coût, tokens, nombre d'appels d'outils, et pour une
tâche de fond **si son compte rendu a déjà été remis ou non**.

```
2 delegations opencode dans cette session, la plus recente en premier.
1 tourne encore.

Une delegation « en cours » est deja en vol : ne pas relancer la meme tache,
elle serait payee deux fois. Si sa reponse est necessaire pour la suite du
raisonnement, attendre son compte rendu plutot que de la relancer.

#1  en cours  ·  glm-5.3-flash-free  ·  session opencode: ses_eac6810…
    6m02 · $0.0031 · 12.4k tokens · 15 appels d'outils · lecture seule
    fond : le compte rendu arrivera tout seul dans un tour suivant, rien a
    attendre ni a relancer
    tache : parite des cles i18n fr/en dans apps/mobile
```

Deux choses que ça débloque, et que `tests/visibility.test.ts` vérifie :

- **ne pas relancer une tâche déjà en vol.** Une délégation `en cours` est
  reconnaissable avant d'être relancée, et le texte le dit explicitement : la
  relancer la ferait payer deux fois.
- **pouvoir décider d'attendre.** Entre l'instant où une tâche de fond finit et
  celui où son compte rendu entre dans un tour, il y a la fenêtre de
  regroupement : la liste dit `pas encore remis, il arrive dans un tour suivant`,
  puis `deja remis dans un tour precedent`. Claude peut donc attendre au lieu de
  repayer. Le cas dégradé est dit aussi : un compte rendu qui n'a pu aller que
  dans le transcript (`claude -p`, Agent SDK, prompt refusé) est annoncé comme
  tel, parce qu'il n'entrera jamais dans un tour.

### `action: "log"`

Avant, Claude ne récupérait que le texte final. Pour savoir quels fichiers
avaient été lus ou quelle piste avait été abandonnée, il devait relancer la tâche
et la repayer. `session.message.list` donne déjà tout, et `recoverPartial` savait
déjà le lire : `log` **réutilise cette lecture**, étendue pour rendre le journal
complet en plus de la tranche bornée que les appelants d'avant utilisent. Une
seule façon de lire `session.message.list` dans le mod, donc une seule à pouvoir
se tromper.

```
Journal de la session opencode ses_eac6810…, relu sans rien relancer ni repayer.
95 appels d'outils au total, affiches 1-40 (du plus ancien au plus recent).

  1. read taxonomy.ts  420ms
  2. grep i18n (error)  3s
  …

Ce qu'opencode a dit (2 prises de parole, de la plus ancienne a la derniere) :

--- 1 ---
piste abandonnee : la taxonomie ne porte pas les cles
…

Journal tronque : il reste 55 appels d'outils. Pour la suite, rappeler cet outil
avec `action: "log"`, `sessionId: "ses_eac6810…"`, `offset: 40`.
```

Le volume est le vrai risque : une session longue peut rendre énormément, et le
résultat d'un outil entre dans le contexte de Claude. Donc : fenêtre de 40 appels
d'outils, 6 000 caractères au total, 1 500 par prise de parole. La sortie **dit
quand elle est tronquée** et donne l'`offset` pour la suite ; `toolsOnly: true`
laisse les textes de côté quand seuls les fichiers lus comptent. Les textes
passent après les appels parce que c'est la partie qui peut exploser, et donc
celle qu'on sacrifie quand la place manque.

Un id qui n'existe pas, ou un service de fond muet, ne donne pas un faux journal
vide : le résultat dit que la relecture a échoué, et que rien n'a été relancé.

### Un seul outil, qui porte une action

La description d'un outil enregistré est relue **à chaque tour, dans toutes les
sessions de tous ceux qui installent le mod**. Celle de `delegate` est déjà
longue. Deux outils de plus auraient voulu dire deux descriptions à payer en
permanence, pour deux capacités qui répondent de toute façon à la même question :
« qu'est-ce que j'ai délégué, et qu'en est-il ? ». D'où un seul outil portant une
`action`, et des descriptions serrées.

## La sortie en JSON

L'idée : qu'un orchestrateur reçoive `{"fichiers": [...], "risques": [...]}`
plutôt qu'un paragraphe à relire. Avant d'implémenter quoi que ce soit, la
question était de savoir par où c'était possible. **La mesure a tranché, et elle
a écarté les deux voies par l'API.**

### Ce que la mesure a montré

Sur opencode **v2.0.32**, mesuré avec de vraies commandes :

- Le corps de `session.prompt` est
  `{id, text, files, agents, skills, metadata, delivery, resume}`, en
  `additionalProperties: false`. **Il n'y a aucun champ de schéma.** Le `format`
  documenté côté SDK n'existe pas sur cette surface HTTP.
- Pire : un `format` envoyé quand même repart en **200**, et le message stocké ne
  garde que `{"text": "…"}`. Le serveur **jette le champ en silence**. Un mod bâti
  là-dessus aurait cru demander un schéma sans jamais être prévenu du contraire.
  Même chose pour `response_format` et `outputSchema`.
- `session.get` rend `id, projectID, cost, tokens, outcome, time, title,
  location` : **pas de `structured_output`**. La chaîne « structured » n'apparaît
  nulle part dans les 818 schémas de l'OpenAPI du serveur.
- `opencode run` n'a pas de drapeau de schéma — `--format` ne vaut que `default`
  ou `json`, c'est le rendu.
- Et pour mémoire, reconfirmé au passage : une session créée par
  `session.create` depuis `/tmp` se voit attribuer
  `location.directory: /Users/paul`, le répertoire du service de fond.

Donc les deux premières voies ne meurent même pas sur la question du répertoire
de travail : elles meurent avant, faute de champ pour porter le schéma. La
troisième voie — demander le JSON dans le prompt et le lire nous-mêmes — est la
seule qui tient, et elle ne sacrifie rien, puisqu'elle garde `opencode run` et
donc le bon répertoire.

### Ce que le mod garantit, et ce qu'il ne garantit pas

**Il ne garantit pas** que la réponse respecte le schéma. Il ne peut pas :
opencode n'offre aucun moyen de l'imposer au fournisseur. Un `schema` passé à
l'outil **n'est pas une contrainte, c'est une demande**.

**Il garantit** la vérification, et l'honnêteté sur son résultat :

- il ajoute la contrainte de forme au prompt envoyé à opencode (le schéma y est
  recopié tel quel), après la tâche demandée, sans toucher au prompt affiché dans
  le pane ;
- il relit la réponse et dit **laquelle des deux il tient en main** : du JSON
  conforme, ou du texte ;
- il lit le JSON nu, dans un bloc ```` ```json ````, ou noyé dans une phrase (le
  premier objet équilibré) ;
- quand le modèle rend du texte, le résultat le dit en clair, explique que le
  schéma n'est pas imposable, et **rend la réponse brute** : le travail payé
  n'est pas jeté ;
- quand le JSON est valide mais hors schéma, il dit ce qui ne colle pas (clé
  requise absente, type déclaré non respecté) et rend l'objet **tel quel** ;
- il **n'invente jamais un champ manquant** et ne corrige rien ;
- un `schema` mal formé ne part pas en silence — c'est précisément le défaut
  reproché à opencode : rien ne tourne, et le résultat le dit.

La vérification est volontairement peu ambitieuse, et le résultat l'annonce :
**clés requises présentes et types déclarés au premier niveau**, rien de plus.
Pas de validation JSON Schema complète, pas de récursion. Mieux vaut dire ce
qu'on vérifie que de laisser croire à une validation qui n'a pas lieu. D'où le
conseil, dans la description du champ : schéma simple et peu profond, et ne pas
en dépendre pour une sortie critique sans la vérifier.

### Ce qui reste non mesuré

**À quelle fréquence un modèle donné suit la consigne.** Les essais sur
`opencode/deepseek-v4.1-flash-free` sont tous repartis en `provider.quota` /
`FreeUsageLimitError` (429) : le palier gratuit était épuisé. Le taux de
conformité est donc une inconnue, et c'est de toute façon une propriété du
modèle, pas du mod. Le comportement du mod face aux deux cas, lui, est testé de
bout en bout (`tests/jsonshape.test.ts`).

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
- **Noms d'arguments** (`dir`, `resume`, `budgetMs`, `background`) choisis pour
  ne pas risquer de collision avec les champs de l'événement `tool.call`,
  puisque les arguments de l'outil arrivent à plat sur `e`.
- **Un job de fond tourne dans `$.clock.after(0, …)`**, pas dans le hook. Un
  rappel de minuteur tourne hors de tout événement : le hook rend la main tout
  de suite, et le travail ne consomme pas le budget d'exécution du hook. La
  contrepartie est que ce rappel meurt avec le module, d'où le marqueur durable
  décrit dans [La délégation en arrière-plan](#la-délégation-en-arrière-plan).
- **Pane maison plutôt que sous-agent natif** : faire apparaître la tâche dans
  le panneau « tâches en arrière-plan » demanderait un vrai sous-agent Claude
  qui relaie vers l'outil, soit un tour de modèle en plus par délégation. Le
  pane coûte zéro et montre ce que le panneau natif n'a pas : coût opencode,
  tokens, id de session.

## Plusieurs délégations à la fois

Le mod ne sérialise rien : deux délégations lancées ensemble tournent vraiment
en parallèle, et `tests/concurrency.test.ts` le vérifie — la courte se termine
pendant que la longue continue.

Ce qui *semble* les sérialiser vient du protocole, pas du mod. Quand Claude émet
plusieurs appels d'outil **dans le même message**, les résultats doivent revenir
ensemble, dans un seul message en retour. Le résultat de la courte est donc prêt
et attend, invisible, que la longue rende la main : si l'une atteint son budget
de dix minutes, rien ne revient avant.

La parade est côté usage : lancer les délégations dans des **messages séparés**,
ou leur donner des budgets comparables. La description de l'outil le dit à
Claude, pour qu'il cesse de les grouper.

`background: true` dissout le problème quand la réponse n'est pas nécessaire
dans le tour en cours : chaque appel rend la main tout de suite, donc plus rien
n'attend personne, et les comptes rendus reviennent au fil des fins — groupés
quand elles tombent ensemble.

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
- `tasks` grandit sans limite sur la durée de la session, et `action: "list"`
  les rend toutes : une session qui délègue des dizaines de fois finira par
  rendre une liste longue.
- `action: "list"` ne voit que les délégations de **la session en cours**. Celles
  d'une autre session Claude, ou d'avant un rechargement du mod, n'y sont pas —
  seul un job de fond perdu par un rechargement revient, par son marqueur.
- Le `schema` d'une délégation n'est **pas imposé** au fournisseur, et ne peut pas
  l'être : opencode 2.0.32 n'a aucun champ de schéma. Voir
  [La sortie en JSON](#la-sortie-en-json) pour la mesure et pour ce qui est
  réellement garanti.
- La vérification du schéma s'arrête aux clés requises et aux types déclarés au
  **premier niveau**. Un objet imbriqué non conforme passe pour conforme.
- Le taux de conformité des modèles au schéma demandé n'a **pas pu être mesuré**
  (palier gratuit épuisé, 429).
- Une délégation de fond **ne peut pas être annulée** : ni le pane ni l'outil
  n'offrent de bouton pour tuer un `$.process.run` en vol. Elle s'arrête d'elle
  même à son budget.
- Le compte rendu de fond entre par `$.prompt.submit`, qui attend que la session
  soit inactive : si l'utilisateur enchaîne les tours, il peut attendre. Et il
  n'entre pas du tout là où aucun prompt n'est soumis (`claude -p`, Agent SDK) —
  le transcript le recueille alors par `$.ui.log`.
- Le marqueur de job de fond est rangé sous l'id de la session Claude. Une
  session reprise qui garde le même id et dont un job a été perdu plus de deux
  heures plus tôt voit son marqueur jeté sans un mot : c'est le compromis assumé
  contre une archéologie qui réveillerait la session pour rien.
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
