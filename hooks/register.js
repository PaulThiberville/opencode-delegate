// opencode-delegate: donne a Claude Code un outil qui delegue une tache a
// opencode 2, et un pane qui suit les taches et choisit le modele.
//
// Le hook `tool.call` lance `opencode run --format json`, qui parle au service
// de fond d'opencode 2 (pas de cold start). Pendant le run, un timer interroge
// `opencode api session.get` pour alimenter le pane : statut, cout, tokens.

const PANE = 'opencode-delegate'
const TOOL = 'mcp__opencode-delegate__delegate'

// `$.process.run` plafonne a dix minutes, et c'est aussi notre plafond de tache
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_TIMEOUT_MS = 300_000
const POLL_MS = 2_000

// Modele de repli, quand le store et l'environnement ne disent rien
const FALLBACK_MODEL = 'ollama-cloud/gpt-oss:20b'
const MAX_RECENT_MODELS = 6
// Un Select n'accepte que 1 a 64 options : au-dela, l'arbre est refuse et le
// moteur dessine son propre pane vide. Le champ de saisie couvre le reste.
const MAX_OPTIONS = 64

// Version minimale d'opencode : `opencode run --format json` et `opencode api`
// n'existent qu'en 2.x
const MIN_MAJOR = 2
// Le preflight bloque le premier prompt, donc il tient en quelques secondes
const PROBE_MS = 5_000


// L'agent opencode en lecture seule, le mode par defaut de toute delegation
const PLAN_AGENT = 'plan'

// Relire la session apres une coupe, et sonder le checkout, prend quelques
// appels de CLI : des budgets courts, pour ne pas ajouter une attente a une
// tache qui vient deja de mourir d'attente
const RECOVER_MS = 15_000
const GIT_MS = 10_000
// Le journal d'outils rendu apres une coupe : assez pour voir ce qu'opencode a
// lu, pas assez pour noyer le resultat
const MAX_RECOVERED_TOOLS = 20
// Ce qu'on recopie du texte retrouve dans le transcript, quand c'est la seule
// voie de sortie (tour abandonne : le resultat de l'outil ne va plus nulle part)
const LOG_EXCERPT = 1_200

// Les marqueurs des delegations de fond en vol, dans le store, une cle par
// session Claude : le store est partage entre toutes les sessions, et une cle
// unique les ferait s'ecraser l'une l'autre
const JOB_PREFIX = 'bg:'
// Deux jobs qui finissent presque ensemble ne notifient qu'une fois : chaque
// `$.prompt.submit` attend que la session soit inactive, donc deux appels font
// deux tours de suite. On laisse donc une courte fenetre de regroupement avant
// de notifier, puis on vide toute la file dans un seul compte rendu.
const GROUP_MS = 1_500
// Le marqueur du job se reecrit quand quelque chose change (session retrouvee,
// checkout sonde) et sinon a ce rythme : de quoi savoir, au rechargement, jusqu'a
// quand la tache tournait, sans reecrire le store a chaque tour de suivi
const HEARTBEAT_MS = 30_000
// Un marqueur plus vieux que ca ne dit plus rien d'utile sur une tache : le
// processus est mort depuis longtemps et personne ne peut plus dire comment
const STALE_MS = 2 * 60 * 60 * 1_000
// Passe son budget, une tache de fond perdue par un rechargement a pu finir
// toute seule : au-dela de cette marge on n'ouvre plus un tour pour elle, on
// l'ecrit seulement dans le transcript et dans le pane
const RELOAD_GRACE_MS = 120_000

// Pourquoi une tache s'est arretee. Les causes ne se traitent pas pareil : un
// budget epuise invite a relancer plus large, un abandon pas du tout, une
// erreur de fournisseur demande de regler le fournisseur d'abord. Le mot sert
// aussi de libelle dans la carte du pane.
const STOPS = {
  budget: {
    word: 'budget',
    line: (task) =>
      'opencode a ete coupe par le mod : le budget de ' +
      clock(Math.round(task.timeoutMs / 1000)) +
      ' est epuise. Ce n\'est ni une erreur d\'opencode ni un abandon : la tache tournait encore. ' +
      'Relancer avec un `budgetMs` plus large (600000 au plafond), ou decouper la tache en morceaux.',
  },
  abandoned: {
    word: 'abandon',
    line: () =>
      "Le tour a ete abandonne pendant la delegation (l'utilisateur a interrompu, ou le moteur a coupe) : " +
      "ce n'est pas un depassement de budget. Ne pas relancer de soi-meme ; attendre que l'utilisateur redemande.",
  },
  provider: {
    word: 'fournisseur',
    line: () =>
      "opencode a echoue cote fournisseur de modele, pas sur la tache. Relancer a l'identique redonnera la " +
      'meme erreur : regarder la cle, le quota ou le modele avant de reessayer.',
  },
  run: {
    word: 'erreur',
    line: () => "opencode s'est arrete en erreur pendant la tache.",
  },
  start: {
    word: 'demarrage',
    line: () =>
      "La commande `opencode` n'a pas pu demarrer, ou est morte bien avant son budget : rien n'a tourne. " +
      'Verifier l\'installation d\'opencode plutot que relancer.',
  },
  // Une delegation de fond, et elle seule, peut mourir de ca : son minuteur
  // vit dans le module, qu'un rechargement remplace
  reload: {
    word: 'rechargement',
    line: () =>
      'Le mod a ete recharge pendant que cette delegation de fond tournait (mise a jour du plugin, ' +
      '`/reload-plugins`, ou perte du worker de hooks) : le minuteur qui la suivait est mort avec ' +
      "l'ancien module, donc personne n'a recu la fin de la tache. Ce n'est ni un echec d'opencode ni " +
      'un abandon : le travail a sans doute continue, et la session opencode en garde la trace. ' +
      'Reprendre par `resume` plutot que relancer la tache depuis le debut.',
  },
}

// Les taches de la session, la plus recente en premier
let tasks = []
let seq = 0

// Le modele que prennent les nouvelles delegations, choisi dans le pane
let defaultModel = FALLBACK_MODEL
// Les derniers modeles utilises, partages entre sessions par $.store
let recentModels = []
// Le catalogue d'`opencode models`, charge en tache de fond pour valider une saisie
let catalog = null
// Ce que le champ de saisie a repondu en dernier
let notice = null
// Quelles sections du pane sont repliees
let folded = { running: false, done: false }
// Quelles cartes montrent le detail de leurs appels d'outils
let openCalls = {}
// L'ecriture est-elle armee ? Volontairement au niveau module, donc remise a
// faux a chaque session : garder l'interrupteur arme d'une session a l'autre
// ferait d'un geste explicite une permission permanente, ce qui n'est plus un
// interrupteur. Il se bascule dans le pane, a cote du selecteur de modele.
let writeArmed = false
// Ce que le preflight a trouve ; `reason` est deja une phrase pour l'utilisateur
let opencode = { isReady: false, version: null, reason: "opencode n'a pas encore ete sonde" }

// Les delegations de fond en vol, par cle, telles qu'on les ecrit dans le store.
// La verite est ici, en memoire : le store n'en est que la copie durable, ce qui
// evite qu'un lire-modifier-ecrire en perde une.
let liveJobs = new Map()
let jobSeq = 0
// L'id de la session Claude, qui range nos marqueurs a part de ceux des autres
let sessionKey = null
// Les comptes rendus de fond prets a notifier, et le drain en cours
let pendingReports = []
let isDraining = false

// Sonde `opencode --version` avant d'enregistrer quoi que ce soit. `$.process.run`
// rejette si le binaire ne demarre pas, d'ou le try/catch ; un code de sortie non
// nul, lui, revient dans le resultat.
async function probeOpencode($) {
  let out
  try {
    out = await $.process.run(['opencode', '--version'], { timeoutMs: PROBE_MS })
  } catch (err) {
    return {
      isReady: false,
      version: null,
      reason: "le binaire `opencode` est introuvable ou ne demarre pas (" + err.message + ')',
    }
  }
  if (out.exitCode !== 0) {
    return {
      isReady: false,
      version: null,
      reason: '`opencode --version` a repondu en erreur (code ' + out.exitCode + ')',
    }
  }
  // « opencode v2.0.32 », et on accepte toute mise en forme autour du numero
  const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out.stdout + '\n' + out.stderr)
  if (!found) {
    return {
      isReady: false,
      version: null,
      reason: '`opencode --version` ne donne pas de numero de version lisible',
    }
  }
  const version = found[0]
  if (Number(found[1]) < MIN_MAJOR) {
    return {
      isReady: false,
      version,
      reason: 'opencode ' + version + ' est trop ancien : la delegation demande une 2.x',
    }
  }
  return { isReady: true, version, reason: null }
}

// Ce que l'utilisateur doit faire, quand l'outil n'a pas ete enregistre
const FIX = 'Installer opencode 2.x (https://opencode.ai), puis relancer la session.'

// Deux contraintes se contredisent. Le palier gratuit d'OpenCode Console
// refuse une session dont l'id n'a pas ete emis par opencode : il lit un id
// invente comme un appel « hors d'OpenCode » et repond 403 FreeTierError. Mais
// une session creee par l'API se voit imposer le repertoire du service de fond,
// celui d'ou il a demarre : la tache lirait et ecrirait la, pas dans le projet,
// et `dir` serait sans effet (ni le corps, ni un parametre, ni un en-tete ne
// le changent). On laisse donc `opencode run` creer sa session, ou le cwd est
// honore, et on la retrouve ensuite pour alimenter le suivi live.
async function findSession($, since, dir) {
  try {
    const listed = await $.process.run(['opencode', 'api', 'session.list'], { timeoutMs: 10_000 })
    if (listed.exitCode !== 0) return null
    const body = JSON.parse(listed.stdout)
    const items = body.data || body
    if (!Array.isArray(items)) return null
    // la liste vient de la plus recente a la plus ancienne
    const match = items.find((item) => {
      const created = item && item.time && item.time.created
      if (typeof created !== 'number' || created < since) return false
      if (!dir) return true
      return ((item.location || {}).directory || null) === dir
    })
    return match && typeof match.id === 'string' ? match.id : null
  } catch {
    return null
  }
}

function parseEvents(stdout) {
  const texts = new Map() // id de part -> texte, le dernier gagne
  const toolCalls = new Map()
  const errors = []
  let sessionId

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.sessionID) sessionId = event.sessionID
    const part = event.part || {}
    if (event.type === 'text' && typeof part.text === 'string') {
      texts.set(part.id || 'text-' + texts.size, part.text)
    } else if (event.type === 'tool_use' && part.tool) {
      const state = part.state || {}
      const time = state.time || {}
      // un meme appel est emis plusieurs fois au fil de son avancement :
      // la derniere version gagne
      toolCalls.set(part.id || 'tool-' + toolCalls.size, {
        tool: part.tool,
        status: state.status || 'unknown',
        title: state.title || part.tool,
        ms: time.start && time.end ? time.end - time.start : null,
      })
    } else if (event.type === 'error') {
      const error = event.error || {}
      errors.push({
        type: typeof error.type === 'string' ? error.type : '',
        message: error.message || 'erreur opencode sans message',
      })
    }
  }

  return {
    text: [...texts.values()].join('\n').trim(),
    toolCalls: [...toolCalls.values()],
    errors,
    sessionId,
  }
}

// `$.process.run` ne rend rien du tout quand il tue le processus : tout ce
// qu'opencode a produit est perdu cote flux NDJSON. La session, elle, l'a garde.
// On la relit donc pour rendre quand meme le dernier texte et le journal des
// outils appeles — sept minutes de lecture valent mieux qu'une ligne d'echec.
//
// La forme n'est pas celle de `session.get` : `{ data: [messages] }`, du plus
// recent au plus ancien ; un message `idle` porte `outcome` et, en cas d'echec,
// `error` ; un message `assistant` porte `content`, ou une part de texte est
// `{ type: 'text', text }` et une part d'outil `{ type: 'tool', name, state }`
// (`name`, pas `tool` comme dans le flux).
async function recoverPartial($, sessionId) {
  if (!sessionId) return null
  let out
  try {
    out = await $.process.run(
      ['opencode', 'api', 'session.message.list', '--param', 'sessionID=' + sessionId],
      { timeoutMs: RECOVER_MS },
    )
  } catch {
    return null
  }
  if (out.exitCode !== 0) return null
  let items
  try {
    const body = JSON.parse(out.stdout)
    items = body.data || body
  } catch {
    return null
  }
  if (!Array.isArray(items)) return null

  let text = null
  let error = null
  let outcome = null
  // Les messages viennent a l'envers du temps, mais les parts d'un message sont
  // dans l'ordre : on garde un groupe par message, puis on remet les groupes
  // dans l'ordre, pour que le journal se lise comme la tache s'est deroulee
  const groups = []
  for (const message of items) {
    if (!message) continue
    const mine = []
    // le plus recent d'abord : le premier `outcome` et la premiere erreur
    // rencontres sont les derniers qu'opencode ait enregistres
    if (!outcome && typeof message.outcome === 'string') outcome = message.outcome
    if (!error && message.error && message.error.message) error = message.error.message
    for (const part of message.content || []) {
      if (!part) continue
      if (part.type === 'text' && typeof part.text === 'string' && !text) {
        text = part.text.trim() || null
      } else if (part.type === 'tool') {
        const name = part.name || part.tool
        const state = part.state || {}
        const time = state.time || {}
        // meme forme que les appels lus dans le flux, pour que la carte n'ait
        // pas deux sortes d'appels a dessiner
        if (name) {
          mine.push({
            tool: name,
            status: state.status || 'unknown',
            // un outil qui n'a pas abouti le dit dans son libelle : la carte
            // comme le compte rendu rendu a Claude le montrent alors
            title:
              (state.title || name) +
              (state.status && state.status !== 'completed' ? ' (' + state.status + ')' : ''),
            ms: time.start && time.end ? time.end - time.start : null,
          })
        }
      }
    }
    if (mine.length) groups.push(mine)
  }

  const tools = []
  for (let i = groups.length - 1; i >= 0; i--) tools.push(...groups[i])
  return { text, error, outcome, tools: tools.slice(-MAX_RECOVERED_TOOLS) }
}

// Ou et sur quoi la tache va tourner. Un agent a conclu de travers parce
// qu'opencode lisait un checkout en retard sans que personne puisse s'en
// apercevoir : le resultat nomme donc toujours le repertoire effectif, le
// commit de depart, l'etat sale, et le retard sur l'amont quand il y en a.
async function probeCheckout($, cwd) {
  const at = { timeoutMs: GIT_MS }
  if (cwd) at.cwd = cwd
  const look = async (argv) => {
    try {
      const out = await $.process.run(argv, at)
      return out.exitCode === 0 ? out.stdout : null
    } catch {
      return null
    }
  }

  // `pwd` plutot qu'un calcul de chemin : un `dir` relatif devient absolu, et
  // le module de hooks n'a pas de quoi joindre deux chemins lui-meme
  const here = await look(['pwd'])
  const found = { dir: here ? here.trim() || null : null, commit: null, branch: null, isDirty: false, behind: 0 }

  // `HEAD --abbrev-ref HEAD` rend le sha puis le nom de branche, en un appel
  const head = await look(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'])
  if (!head) return found
  const lines = head.trim().split('\n')
  found.commit = (lines[0] || '').slice(0, 12) || null
  // un HEAD detache rend « HEAD » comme nom de branche : rien a nommer
  if (lines[1] && lines[1] !== 'HEAD') found.branch = lines[1]

  const status = await look(['git', 'status', '--porcelain'])
  found.isDirty = Boolean(status && status.trim())

  // Le cas qui a produit la fausse conclusion : un checkout en retard sur son
  // amont. Sans amont configure, la commande sort en erreur et on n'en dit rien.
  const behind = await look(['git', 'rev-list', '--count', 'HEAD..@{upstream}'])
  if (behind) found.behind = Number(behind.trim()) || 0
  return found
}

// Un build sans `next.signal` ne doit pas faire echouer le traitement d'un echec
function isAborted(next) {
  try {
    return Boolean(next.signal && next.signal.aborted)
  } catch {
    return false
  }
}

// 8s, 1m12, 11m05
function clock(total) {
  if (total < 60) return total + 's'
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return minutes + 'm' + seconds
}

// La carte represente une session opencode, pas un appel : une reprise ajoute
// un segment a la meme carte, et la duree affichee est leur somme
function elapsed(task) {
  const segments = task.segments || [{ startedAt: task.startedAt, endedAt: task.endedAt }]
  const total = segments.reduce((sum, seg) => sum + ((seg.endedAt || Date.now()) - seg.startedAt), 0)
  return Math.round(total / 1000)
}

// Ce qu'opencode a consomme sur toute la session, tel que le serveur le compte
function tokens(task) {
  const t = task.tokens
  if (!t) return ''
  const used = (t.input || 0) + (t.output || 0) + (t.reasoning || 0)
  if (!used) return ''
  const label = used >= 1000 ? (used / 1000).toFixed(1) + 'k' : String(used)
  return label + ' tokens'
}

// Fin du segment en cours : c'est lui qui alimente la duree cumulee
function closeSegment(task) {
  task.liveCalls = null
  const segments = task.segments || []
  const last = segments[segments.length - 1]
  if (last && !last.endedAt) last.endedAt = Date.now()
}

function duration(task) {
  return clock(elapsed(task))
}

function money(cost) {
  if (typeof cost !== 'number' || cost === 0) return ''
  return '$' + cost.toFixed(4)
}

// ollama-cloud/gpt-oss:20b -> gpt-oss:20b, pour tenir dans une colonne
function shortModel(model) {
  const slash = model.indexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

function fit(text, width) {
  if (width <= 1) return ''
  return text.length > width ? text.slice(0, width - 1) + '…' : text
}

// Les recents d'abord, puis les modeles des memes fournisseurs, puis le reste,
// le tout coupe a ce qu'un Select accepte
function modelChoices() {
  const seen = new Set()
  const out = []
  const push = (model) => {
    if (!model || seen.has(model) || out.length >= MAX_OPTIONS) return
    seen.add(model)
    out.push(model)
  }
  recentModels.forEach(push)
  const providers = new Set(recentModels.map((m) => m.split('/')[0]))
  const rest = catalog || []
  rest.filter((m) => providers.has(m.split('/')[0])).forEach(push)
  rest.forEach(push)
  return out
}

function rememberModel(model) {
  recentModels = [model, ...recentModels.filter((m) => m !== model)].slice(0, MAX_RECENT_MODELS)
}

async function saveModels($) {
  try {
    await $.store.set('defaultModel', defaultModel)
    await $.store.set('recentModels', recentModels)
  } catch {
    // le store peut refuser : le choix reste valable pour la session
  }
}

// --- le compte rendu rendu a Claude ---------------------------------------

// Ou et sur quoi la tache a tourne : la ligne que personne n'avait, et sans
// laquelle un checkout en retard produit une conclusion fausse sans trace
function whereLine(checkout) {
  const found = checkout || {}
  return (
    'ou: ' +
    [
      found.dir || '(repertoire inconnu)',
      found.commit ? '@ ' + found.commit : '(hors depot git)',
      found.branch ? '(' + found.branch + ')' : null,
      found.commit ? (found.isDirty ? 'checkout sale' : 'checkout propre') : null,
    ]
      .filter(Boolean)
      .join(' ')
  )
}

function behindLine(checkout) {
  const behind = (checkout || {}).behind
  return behind
    ? '/!\\ ce checkout est ' +
        behind +
        " commit(s) derriere son amont : la tache a lu un etat en retard. Peser la conclusion en consequence, et verifier sur un checkout a jour avant d'en tirer quoi que ce soit."
    : null
}

function footer(task) {
  return [
    task.sessionId ? 'session opencode: ' + task.sessionId : null,
    'modele: ' + task.model,
    'mode: ' + (task.mayWrite ? 'ecriture autorisee par l\'utilisateur' : 'lecture seule (agent plan)'),
    'duree: ' + duration(task),
    task.cost ? 'cout: ' + money(task.cost) : null,
    task.toolCount ? 'outils: ' + task.toolCount + ' appels' : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

// Le plafond de dix minutes porte sur un appel de `$.process.run`, pas sur
// une tache : la session opencode, elle, garde son historique. Un echec qui
// ne rend pas son id casse la chaine — Claude n'a plus de quoi reprendre, et
// une tache longue a l'air hors de portee du mod alors qu'elle se mene en
// plusieurs reprises. On le dit donc explicitement, et on dit aussi quand il
// n'y a pas d'id, pour ne pas laisser croire a une reprise possible.
function resumeLine(task) {
  return task.sessionId
    ? 'Reprise possible : rappeler cet outil avec `resume: "' +
        task.sessionId +
        '"` continue dans la meme session opencode, qui garde tout son historique. Le budget plafonne un appel, pas une tache : une tache longue se mene en plusieurs reprises.'
    : "Pas de reprise possible : la session opencode n'a pas ete retrouvee, donc pas d'id a passer dans `resume`. Il faudrait relancer la tache depuis le debut."
}

// Le pied commun a tous les comptes rendus
function tailLines(task) {
  const lines = ['', '---', footer(task), whereLine(task.checkout)]
  const behind = behindLine(task.checkout)
  if (behind) lines.push(behind)
  return lines
}


// --- les delegations de fond ----------------------------------------------

// Le marqueur durable d'un job de fond. Il existe pour une seule raison : un
// rechargement du module tue les minuteurs, donc le job en vol n'a plus personne
// pour le conclure. Sans marqueur, sa carte resterait « en cours » a mentir
// indefiniment et son resultat ne reviendrait jamais.
async function saveJobs($) {
  if (!sessionKey) return
  const key = JOB_PREFIX + sessionKey
  try {
    if (liveJobs.size === 0) await $.store.delete(key)
    else await $.store.set(key, { updatedAt: Date.now(), jobs: [...liveJobs.values()] })
  } catch {
    // le store peut refuser : on perd alors la trace du job au rechargement,
    // ce qui est exactement l'etat d'avant ce marqueur
  }
}

// Reecrit le marqueur quand quelque chose a change, et sinon au rythme du
// battement : le reecrire a chaque tour de suivi ne servirait a rien
async function touchJob($, job, patch) {
  if (!job) return
  let changed = false
  for (const [field, value] of Object.entries(patch || {})) {
    if (job[field] !== value && value !== undefined) {
      job[field] = value
      changed = true
    }
  }
  const now = Date.now()
  if (!changed && now - (job.savedAt || 0) < HEARTBEAT_MS) return
  job.lastSeenAt = now
  job.savedAt = now
  await saveJobs($)
}

// Un compte rendu de fond ne revient pas par le resultat de l'outil, qui a
// rendu la main depuis longtemps : il revient par un tour a lui.
//
// Chaque `$.prompt.submit` attend que la session soit inactive et resout quand
// son tour demarre : deux appels font donc deux tours de suite, le second
// coupant ce que l'utilisateur a commence apres avoir lu le premier. On attend
// donc GROUP_MS, le temps qu'un job qui finit presque en meme temps rejoigne la
// file, puis on vide toute la file dans un seul compte rendu. Les jobs qui
// finissent pendant l'attente de l'inactivite font un second tour, groupe de
// la meme facon.
function notify($, report) {
  pendingReports.push(report)
  if (isDraining) return
  isDraining = true
  $.clock.after(GROUP_MS, async () => {
    let batch = []
    try {
      while (pendingReports.length) {
        batch = pendingReports
        pendingReports = []
        await $.prompt.submit({ text: groupReports(batch) })
        batch = []
      }
    } catch (err) {
      // la notification n'a pas pu entrer (prompt refuse, session qui se
      // ferme) : le transcript reste la seule voie pour rendre ce qui a ete paye
      $.ui.log(
        "opencode: le compte rendu de la delegation de fond n'a pas pu etre remis (" +
          ((err && err.message) || 'cause inconnue') +
          ') :\n' +
          batch.join('\n'),
      )
    } finally {
      isDraining = false
    }
  })
}

function groupReports(reports) {
  if (reports.length === 1) {
    return [
      'Compte rendu de la delegation opencode lancee en arriere-plan. C\'est le resultat differe d\'un',
      'appel a `' + TOOL + '` qui avait rendu la main tout de suite : il n\'y a rien a relancer, rien a',
      'attendre de plus, et cet outil ne doit pas etre rappele pour cette tache. En reprendre le fil la',
      'ou la conversation en etait.',
      '',
      reports[0],
    ].join('\n')
  }
  const head = [
    reports.length + ' delegations opencode lancees en arriere-plan viennent de finir, et voici leurs',
    'comptes rendus. Ce sont les resultats differes d\'appels a `' + TOOL + '` qui avaient rendu la main',
    'tout de suite : il n\'y a rien a relancer ni a attendre de plus. Ils sont groupes en un seul tour',
    'parce que chaque notification ouvre un tour a elle et couperait celui d\'a cote.',
  ].join('\n')
  const bodies = reports.map(
    (report, index) => '=== delegation ' + (index + 1) + '/' + reports.length + ' ===\n' + report,
  )
  return [head, '', ...bodies].join('\n')
}

// Ce que l'outil rend quand il vient de lancer une tache de fond : assez clair
// pour que Claude n'attende pas et ne rappelle pas l'outil une seconde fois
function launched(spec) {
  return [
    'Delegation lancee en arriere-plan : cet appel a rendu la main tout de suite, et opencode travaille',
    'maintenant de son cote. NE PAS attendre, NE PAS rappeler cet outil pour cette tache, ne pas la',
    'relancer : le compte rendu complet (reponse d\'opencode, id de session a repasser dans `resume`,',
    'repertoire, commit de depart, duree, et la cause quand la tache s\'arrete sans conclure) arrivera',
    'tout seul dans un tour suivant, sans que rien soit demande. Repondre a l\'utilisateur et continuer',
    'autre chose en attendant.',
    '',
    'budget: ' + clock(Math.round(spec.timeoutMs / 1000)) + ' au plus',
    'modele: ' + spec.model,
    'mode: ' + (spec.mayWrite ? 'ecriture autorisee par l\'utilisateur' : 'lecture seule (agent plan)'),
    spec.resume ? 'reprise de la session opencode ' + spec.resume : 'nouvelle session opencode',
    '',
    'Suivi en direct dans le pane `/opencode` : la carte de la tache y vit comme celle de n\'importe',
    'quelle delegation. Un rechargement du mod pendant la tache est le seul cas ou le compte rendu',
    'arrive degrade : il dit alors que la tache a ete perdue par le rechargement, et comment reprendre.',
  ].join('\n')
}

// Reprend les jobs de fond que le module d'avant a laisses dans le store : ils
// tournaient quand il est mort, et plus personne ne les conclura. Fait son
// travail DANS le hook de demarrage, avant que l'outil ne soit enregistre : un
// job lance entre-temps ecrirait son marqueur sous la meme cle, et le balayage
// le prendrait pour un orphelin alors qu'il tourne encore.
async function claimOrphans($) {
  let keys
  try {
    keys = await $.store.keys()
  } catch {
    return []
  }
  if (!Array.isArray(keys)) return []
  const mine = JOB_PREFIX + sessionKey
  const orphans = []
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith(JOB_PREFIX)) continue
    let held
    try {
      held = await $.store.get(key)
    } catch {
      continue
    }
    const jobs = held && Array.isArray(held.jobs) ? held.jobs : []
    if (key === mine) {
      // notre propre session : ces jobs etaient en vol quand le module est
      // tombe. On les reprend a notre compte, puis on nettoie la cle. Un job
      // que ce module-ci a lance n'en est pas un, et sa cle le dit.
      for (const job of jobs) {
        if (!job || liveJobs.has(job.key)) continue
        if (Date.now() - (job.startedAt || 0) < STALE_MS) orphans.push(job)
      }
      try {
        await $.store.delete(key)
      } catch {
        // tant pis : le prochain demarrage les relira et les trouvera perimes
      }
    } else if (!held || Date.now() - (held.updatedAt || 0) > STALE_MS) {
      // une autre session, abandonnee depuis longtemps : menage
      try {
        await $.store.delete(key)
      } catch {}
    }
  }
  return orphans
}

// Puis on en rend compte, hors evenement : notifier attend que la session soit
// inactive, et relire une session opencode prend quelques appels de CLI
async function reportOrphans($, orphans) {
  if (orphans.length === 0) return

  await $.ui.open({ id: PANE, title: 'opencode' })
  for (const job of orphans) {
    const report = await reportOrphan($, job)
    // Passe son budget et la marge, la tache a pu finir toute seule depuis
    // longtemps : ouvrir un tour pour en parler reveillerait la session pour
    // une archeologie. La carte et le transcript le disent, ca suffit.
    const deadline = (job.lastSeenAt || job.startedAt || 0) + (job.timeoutMs || DEFAULT_TIMEOUT_MS)
    if (Date.now() < deadline + RELOAD_GRACE_MS) notify($, report)
    else $.ui.log('opencode (delegation de fond perdue par un rechargement) :\n' + report)
  }
}

// La carte d'un job perdu, reconstruite depuis son marqueur : elle existe pour
// que le pane ne montre pas une tache « en cours » qui n'a plus personne
async function reportOrphan($, job) {
  const startedAt = job.startedAt || Date.now()
  const endedAt = job.lastSeenAt || startedAt
  const task = {
    id: ++seq,
    prompt: job.prompt || '',
    model: job.model || defaultModel,
    agent: job.agent || null,
    mayWrite: Boolean(job.mayWrite),
    isBackground: true,
    sessionId: job.sessionId || null,
    title: job.title || null,
    status: 'failed',
    stop: 'reload',
    startedAt,
    endedAt,
    segments: [{ startedAt, endedAt }],
    runs: 1,
    cuts: 1,
    cost: job.cost || 0,
    tokens: null,
    toolCalls: [],
    checkout: job.checkout || null,
    timeoutMs: job.timeoutMs || DEFAULT_TIMEOUT_MS,
  }
  tasks = [task, ...tasks]

  const partial = await recoverPartial($, task.sessionId)
  if (partial && partial.tools.length) {
    task.toolCalls = partial.tools
    task.toolCount = partial.tools.length
  }
  $.ui.invalidate('ui.render')
  $.ui.toast('opencode: delegation de fond perdue par un rechargement')

  const body = [STOPS.reload.line(task)]
  body.push('', 'La tache etait : ' + fit(task.prompt, 400))
  if (partial && partial.error) body.push("Derniere erreur enregistree par la session : " + partial.error)
  if (partial && partial.text) {
    body.push('', "Ce qu'opencode avait produit, relu dans sa session :", '', partial.text)
  } else {
    body.push(
      '',
      "La session d'opencode ne garde aucun texte : soit elle n'a pas ete retrouvee, soit opencode n'avait rien conclu.",
    )
  }
  if (partial && partial.tools.length) {
    body.push('', 'Outils appeles : ' + partial.tools.map((call) => call.title).join(', '))
  }
  body.push('', resumeLine(task))
  body.push(...tailLines(task))
  return body.join('\n')
}


// --- la delegation elle-meme ----------------------------------------------

// Une delegation, bloquante ou de fond. `spec` est fige au moment de l'appel de
// l'outil : notamment `mayWrite`, lu sur l'interrupteur du pane dans le hook et
// jamais relu ici, pour qu'un job differe n'ecrive pas parce que l'interrupteur
// a ete arme apres coup. `next` ne vient que du mode bloquant : un job de fond
// n'a plus de dispatch a abandonner. `job` est le marqueur durable, present en
// mode de fond seulement.
async function runDelegation($, spec, next, job) {
  const { model, timeoutMs, mayWrite, agent } = spec

  // `next.signal` s'abat quand l'evenement est abandonne : c'est a ca qu'on
  // reconnait un tour interrompu d'un budget epuise, deux causes qui ne se
  // traitent pas pareil.
  let isAbandoned = false
  if (next) {
    try {
      if (next.signal.aborted) isAbandoned = true
      else next.signal.addEventListener('abort', () => { isAbandoned = true }, { once: true })
    } catch {
      // pas de signal sur ce build : on ne distinguera pas l'abandon
    }
  }

  // Une session reprise existe deja, avec le repertoire ou elle est nee ; une
  // nouvelle sera creee par `opencode run` lui-meme, puis retrouvee
  const sessionId = spec.resume || null

  // Ou et sur quoi la tache va tourner, avant de la lancer : `pwd` resout un
  // `dir` relatif en absolu, ce qui donne aussi de quoi reconnaitre la session
  // a suivre dans `session.list`.
  const checkout = await probeCheckout($, spec.dir)
  let targetDir = checkout.dir
  if (!targetDir) {
    if (spec.sessionCwd !== undefined) {
      // lu dans le hook : un minuteur qui survit a son hook lirait le
      // repertoire de la session au moment ou il tourne, pas celui de l'appel
      targetDir = spec.sessionCwd
    } else {
      try {
        targetDir = spec.dir ? null : (await $.session.cwd()) || null
      } catch {
        targetDir = null
      }
    }
  }

  // Une reprise continue la meme carte : l'unite affichee est la session
  // opencode, pas l'appel d'outil. Deux cartes au meme titre ne disaient rien
  // de plus que « c'est la meme conversation ».
  const resumed = spec.resume ? tasks.find((item) => item.sessionId === spec.resume) : null
  const task = resumed || { id: ++seq, toolCalls: [], segments: [], runs: 0, cuts: 0, cost: 0, tokens: null }
  Object.assign(task, {
    prompt: spec.prompt,
    model,
    agent,
    mayWrite,
    isBackground: Boolean(spec.isBackground),
    sessionId: sessionId || task.sessionId,
    status: 'running',
    startedAt: Date.now(),
    timeoutMs,
    checkout,
    stop: null,
    error: undefined,
  })
  task.runs += 1
  task.segments.push({ startedAt: task.startedAt })
  // la reprise repasse la carte en tete, et dans « En cours »
  tasks = resumed ? [task, ...tasks.filter((item) => item !== task)] : [task, ...tasks]

  await touchJob($, job, { checkout, sessionId: task.sessionId || undefined })
  await $.ui.open({ id: PANE, title: 'opencode' })
  $.ui.invalidate('ui.render')

  let watched = sessionId
  // Le journal des outils se relit dans la session, pas dans le flux : celui
  // de `opencode run` n'arrive qu'a la sortie du processus. On espace cette
  // relecture, plus lourde qu'un `session.get`, un tour sur deux.
  let tick = 0
  const poll = $.clock.every(POLL_MS, async () => {
    if (!watched) {
      // la session nait au premier evenement du run, pas avant
      watched = await findSession($, task.startedAt - 2_000, targetDir)
      if (!watched) return
      task.sessionId = watched
    }
    try {
      const probe = await $.process.run(
        ['opencode', 'api', 'session.get', '--param', 'sessionID=' + watched],
        { timeoutMs: 10_000 },
      )
      if (probe.exitCode !== 0) return
      const body = JSON.parse(probe.stdout)
      const info = body.data || body
      if (typeof info.cost === 'number') task.cost = info.cost
      if (info.tokens) task.tokens = info.tokens
      if (info.title) task.title = info.title
    } catch {
      // la session n'existe pas encore, ou le service repond mal : on reessaie
    }
    if (++tick % 2 === 0) {
      const live = await recoverPartial($, watched)
      // la session porte le journal de tous ses segments : il remplace la
      // liste courante au lieu de s'y ajouter
      if (live && live.tools.length) task.liveCalls = live.tools
    }
    // le marqueur suit, pour qu'un rechargement sache quelle session reprendre
    // et jusqu'a quand la tache tournait
    await touchJob($, job, { sessionId: task.sessionId || undefined, title: task.title, cost: task.cost })
    $.ui.invalidate('ui.render')
  })

  // `--auto` auto-approuve tout ce qui n'est pas explicitement refuse : il ne
  // sort que pour une ecriture autorisee a l'instant par l'utilisateur. En
  // lecture seule, l'agent `plan` n'a pas d'outil d'ecriture et rien a approuver.
  const argv = ['opencode', 'run', '--format', 'json', '-m', model]
  if (mayWrite) argv.push('--auto')
  if (spec.resume) argv.push('--session', spec.resume)
  if (agent) argv.push('--agent', agent)
  argv.push(task.prompt)

  const init = { timeoutMs }
  if (spec.dir) init.cwd = spec.dir

  // Ce qui est rendu quand la tache s'arrete sans conclusion : la cause, ce
  // qu'opencode avait deja produit, ou ca a tourne, et comment reprendre
  const giveUp = async (stop, detail) => {
    poll.cancel()
    task.status = 'failed'
    task.stop = stop
    task.cuts += 1
    task.endedAt = Date.now()
    closeSegment(task)
    if (detail) task.error = detail

    // La session garde ce que `$.process.run` a jete en tuant le processus
    let found = task.sessionId
    if (!found && !spec.resume) found = await findSession($, task.startedAt - 2_000, targetDir)
    const partial = await recoverPartial($, found)
    if (found) task.sessionId = found
    if (partial && partial.tools.length) {
      task.toolCalls = [...task.toolCalls, ...partial.tools]
      task.toolCount = task.toolCalls.length
    }
    $.ui.invalidate('ui.render')
    $.ui.toast('opencode: ' + STOPS[stop].word + ' en ' + duration(task))

    const body = [STOPS[stop].line(task)]
    if (detail) body.push('Detail : ' + detail)
    if (partial && partial.error) body.push("Derniere erreur enregistree par la session : " + partial.error)
    if (partial && partial.text) {
      body.push('', "Ce qu'opencode avait deja produit, relu dans sa session :", '', partial.text)
    } else {
      body.push('', "La session d'opencode ne garde aucun texte : il n'avait rien conclu avant l'arret.")
    }
    if (partial && partial.tools.length) {
      body.push('', 'Outils appeles avant l\'arret : ' + partial.tools.map((call) => call.title).join(', '))
    }
    body.push('', resumeLine(task))
    body.push(...tailLines(task))

    // Un tour abandonne a deja repris sans nous : le resultat de l'outil ne va
    // plus nulle part, et le transcript est la seule voie qui reste pour rendre
    // a l'utilisateur ce qu'il a paye
    if (stop === 'abandoned' && partial && partial.text) {
      $.ui.log(
        'opencode (tache abandonnee, texte retrouve dans la session ' +
          (task.sessionId || '?') +
          ') :\n' +
          partial.text.slice(0, LOG_EXCERPT),
      )
    }
    return { result: body.join('\n') }
  }

  // Un chronometre sur le budget : s'il s'est declenche avant que
  // `$.process.run` rejette, c'est que le processus a tenu jusqu'au bout et
  // que c'est le budget qui l'a tue. Sans lui, les trois rejets possibles de
  // `$.process.run` — budget epuise, commande qui ne demarre pas, evenement
  // abandonne — se ressemblent tous.
  let isOutOfBudget = false
  const fuse = $.clock.after(timeoutMs, () => {
    isOutOfBudget = true
  })

  let run
  try {
    run = await $.process.run(argv, init)
  } catch (err) {
    fuse.cancel()
    const stop = isAbandoned || (next && isAborted(next)) ? 'abandoned' : isOutOfBudget ? 'budget' : 'start'
    return giveUp(stop, err.message)
  }
  fuse.cancel()
  poll.cancel()

  const parsed = parseEvents(run.stdout)
  task.endedAt = Date.now()
  closeSegment(task)
  if (!task.sessionId && parsed.sessionId) task.sessionId = parsed.sessionId
  task.toolCalls = [...task.toolCalls, ...parsed.toolCalls]
  task.toolCount = task.toolCalls.length
  task.lastTool = parsed.toolCalls.length ? parsed.toolCalls[parsed.toolCalls.length - 1].tool : null

  if (parsed.errors.length || run.exitCode !== 0) {
    // Une erreur `provider.*` ne vient pas de la tache : relancer a
    // l'identique redonnera la meme chose, et Claude doit le savoir
    const isProvider = parsed.errors.some((err) => err.type.startsWith('provider'))
    const why =
      parsed.errors.map((err) => err.message).join(' | ') ||
      run.stderr.trim() ||
      'code de sortie ' + run.exitCode
    task.status = 'failed'
    task.stop = isProvider ? 'provider' : 'run'
    task.cuts += 1
    task.error = why
    $.ui.invalidate('ui.render')
    $.ui.toast('opencode: ' + STOPS[task.stop].word + ' en ' + duration(task))
    const body = [STOPS[task.stop].line(task), 'Detail : ' + why]
    if (parsed.text) body.push('', "Ce qu'opencode avait produit avant l'erreur :", '', parsed.text)
    body.push('', resumeLine(task))
    body.push(...tailLines(task))
    return { result: body.join('\n') }
  }

  task.status = 'done'
  $.ui.invalidate('ui.render')
  $.ui.toast('opencode: termine en ' + duration(task))

  const answer = parsed.text || '(opencode a fini sans texte de reponse)'
  return { result: answer + tailLines(task).join('\n') }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('defaultModel')
      if (typeof saved === 'string' && saved) defaultModel = saved
      const savedRecent = await $.store.get('recentModels')
      if (Array.isArray(savedRecent)) recentModels = savedRecent.filter((m) => typeof m === 'string')
    } catch {
      // premier demarrage, ou store illisible : on garde les valeurs de repli
    }
    if (!recentModels.includes(defaultModel)) rememberModel(defaultModel)

    const fromEnv = await $.env.get('OPENCODE_DELEGATE_MODEL')
    if (fromEnv) {
      defaultModel = fromEnv
      rememberModel(fromEnv)
    }

    // Preflight : sans opencode 2.x, l'outil n'est pas enregistre du tout.
    // Le proposer quand meme ferait appeler par Claude un outil qui ne peut que
    // echouer, au prix d'un tour de modele et d'une erreur illisible.
    opencode = await probeOpencode($)
    if (!opencode.isReady) {
      $.ui.log('delegation vers opencode desactivee : ' + opencode.reason + ' ' + FIX)
    }

    // L'id de la session range nos marqueurs de jobs de fond a part de ceux des
    // autres sessions, qui partagent le meme store
    try {
      sessionKey = (await $.session.id()) || null
    } catch {
      sessionKey = null
    }

    // Un rechargement du module (mise a jour du plugin, `/reload-plugins`,
    // perte du worker de hooks) tue les minuteurs : les jobs de fond en vol
    // n'ont plus personne pour les conclure, et leur carte resterait « en
    // cours » a mentir indefiniment. `session.start` repasse a chaque
    // chargement : c'est ici qu'on reprend leurs marqueurs, avant d'enregistrer
    // l'outil, pour qu'aucune nouvelle delegation n'ecrive dans la meme cle
    // pendant le balayage. Le compte rendu, lui, part hors de l'evenement.
    const orphans = opencode.isReady && sessionKey ? await claimOrphans($) : []
    if (orphans.length) $.clock.after(0, () => reportOrphans($, orphans))

    if (opencode.isReady) {
      await $.tool.register({
        name: 'delegate',
        description: [
          'Delegue une tache autonome a opencode, un autre agent de code qui tourne',
          'sur ses propres modeles (moins chers que ceux de cette session).',
          'A utiliser pour une tache bien delimitee et descriptible en texte :',
          'exploration, refactor mecanique, ecriture de tests, resume de code.',
          "Par defaut la tache part en LECTURE SEULE (agent `plan` d'opencode) :",
          'opencode lit le depot et rend un compte rendu, mais ne modifie aucun',
          'fichier. Pour une tache qui doit ecrire, passer `writeFiles: true` :',
          "la delegation ne part que si l'utilisateur a arme l'ecriture dans le",
          'pane `/opencode`, un interrupteur qui se desarme a chaque nouvelle',
          'session. Si elle ne l\'est pas, rien ne tourne et le resultat le dit :',
          "le demander a l'utilisateur plutot que de reessayer. Ne pas passer",
          '`writeFiles` pour une tache dont le perimetre de fichiers est flou.',
          "L'outil rend la reponse finale d'opencode, plus l'id de session a passer",
          'dans `resume` pour un suivi sur la meme conversation opencode, le',
          'repertoire ou la tache a tourne et le commit de depart.',
          "Quand la tache s'arrete sans conclure, le resultat dit pourquoi",
          '(budget epuise, tour abandonne, erreur de fournisseur, demarrage',
          "impossible) et rend quand meme ce qu'opencode avait deja produit,",
          "relu dans sa session, plus l'id a repasser dans `resume` pour",
          'reprendre la. Le budget plafonne un appel, pas une tache : une tache',
          'longue se mene en plusieurs reprises sur la meme session opencode.',
          'Lancer les delegations dans des messages separes plutot que plusieurs',
          'dans le meme : les appels d\'outil emis ensemble rendent leurs resultats',
          'ensemble, donc une delegation courte groupee avec une longue reste',
          "invisible jusqu'a ce que la longue finisse. Elles tournent bien en",
          'parallele, mais rien ne revient avant la derniere.',
          "Passer `background: true` quand la reponse d'opencode n'est pas",
          'necessaire pour raisonner dans ce tour-ci : l\'appel rend la main tout',
          'de suite et le compte rendu complet revient plus tard, tout seul, sans',
          "qu'il y ait a attendre ni a rappeler l'outil. C'est ce qui garde la",
          'conversation disponible pendant une longue tache.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                "La consigne complete pour opencode. Il ne voit rien de cette conversation : tout le contexte necessaire doit etre dans ce texte.",
            },
            writeFiles: {
              type: 'boolean',
              description:
                "A passer a true seulement si la tache doit modifier des fichiers, et seulement si l'utilisateur a arme l'ecriture dans le pane `/opencode`. Sinon rien ne part. Sans ce champ, la tache tourne en lecture seule, ce qui est le defaut.",
            },
            model: {
              type: 'string',
              description:
                "Modele au format provider/model. Par defaut, celui choisi dans le pane /opencode.",
            },
            agent: {
              type: 'string',
              description:
                "Agent opencode a utiliser. Honore seulement si l'ecriture a ete autorisee ; en lecture seule, l'agent `plan` est impose.",
            },
            dir: {
              type: 'string',
              description:
                "Repertoire de travail de la tache, absolu ou relatif a la session. Par defaut celui de la session. Le resultat nomme toujours le repertoire effectif, le commit de depart et l'etat du checkout, pour qu'une tache qui a lu un etat en retard soit reconnaissable. Ce champ n'accepte pas de reference git : pour lire un etat independant du checkout de l'operateur, lui demander un worktree et passer son chemin.",
            },
            resume: {
              type: 'string',
              description:
                "Id de session opencode rendu par un appel precedent, pour continuer la meme conversation.",
            },
            budgetMs: {
              type: 'number',
              description:
                "Budget de temps en millisecondes, 300000 par defaut, 600000 au maximum. Au-dela, la tache est coupee : le resultat le dit et rend ce qu'opencode avait deja produit, ce qui permet de relancer plus large en connaissance de cause.",
            },
            background: {
              type: 'boolean',
              description:
                "A passer a true pour que l'appel rende la main tout de suite : la tache part en arriere-plan et le compte rendu complet revient plus tard, tout seul, dans un tour a lui. A utiliser quand la reponse d'opencode n'est pas necessaire pour raisonner dans ce tour-ci, pour rester disponible pour l'utilisateur pendant qu'opencode travaille. Ne pas le passer quand la suite du raisonnement depend du resultat : le mode bloquant reste le bon dans ce cas. Avec `background`, ne jamais attendre ni rappeler l'outil pour la meme tache.",
            },
          },
          required: ['prompt'],
        },
        isDeferred: false,
      })
    }

    try {
      await $.command.register({
        name: 'opencode',
        description: 'Ouvre le pane opencode : taches en cours et choix du modele',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('commande /opencode non enregistree: ' + err.message)
    }

    // Le catalogue sert a valider une saisie libre ; il peut arriver en retard.
    // Sans opencode, le pane n'affiche pas de selecteur : rien a charger.
    if (opencode.isReady) $.clock.after(0, async () => {
      try {
        const listing = await $.process.run(['opencode', 'models'], { timeoutMs: 20_000 })
        if (listing.exitCode !== 0) return
        catalog = listing.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      } catch {
        // opencode absent ou lent : la saisie libre restera non verifiee
      }
    })

    return next(e)
  })

  // Dit a Claude, des le premier message, que la delegation existe
  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    // Sans outil enregistre, annoncer la capacite promettrait a Claude un outil
    // qui n'existe pas
    if (!opencode.isReady) return below
    const block = {
      name: 'opencodeDelegate',
      text: [
        'Cette session peut deleguer une tache a opencode, un second agent de code',
        'qui tourne sur ses propres modeles, bien moins chers que celui de cette',
        'session. Outil : `' + TOOL + '`. Modele courant : ' + defaultModel + '.',
        '',
        'Y penser pour une tache autonome et descriptible en texte : exploration',
        'large de la codebase, refactor mecanique, ecriture de tests, resume de',
        "fichiers, verification repetitive. opencode ne voit rien de cette",
        'conversation : tout le contexte utile doit tenir dans le prompt envoye.',
        '',
        "Par defaut la delegation est en lecture seule : opencode lit le depot et",
        "rend un compte rendu, sans toucher aux fichiers. Pour une tache qui doit",
        "ecrire, passer `writeFiles: true` : elle ne part que si l'utilisateur a",
        "arme l'ecriture dans le pane `/opencode`. Sinon rien ne tourne, et il faut",
        'le lui demander. Ne pas le passer pour une tache dont le perimetre de',
        'fichiers est flou.',
        '',
        "Le resultat nomme le repertoire effectif, le commit de depart et l'etat du",
        "checkout. Quand la tache est coupee, il dit pourquoi et rend quand meme ce",
        "qu'opencode avait deja produit.",
        '',
        "Par defaut l'appel attend la fin de la tache. Avec `background: true`, il",
        'rend la main tout de suite et le compte rendu revient plus tard tout seul,',
        'dans un tour a lui : a prendre quand la reponse n\'est pas necessaire pour',
        'raisonner dans le meme tour, pour rester disponible pendant la tache.',
      ].join('\n'),
    }
    return { blocks: [...below.blocks, block] }
  })

  on('command.run', { command: 'opencode' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'opencode', focus: true, closeOnEscape: true })
    return {}
  })

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const isBackground = Boolean(e.background)

    // L'ecriture n'est jamais implicite : Claude la demande, l'utilisateur la
    // donne par l'interrupteur du pane, ou personne ne peut repondre ; dans les
    // deux cas rien ne part. opencode tourne avec `--auto` : ses ecritures ne
    // passent ni par le mode auto de Claude Code, ni par les regles de
    // permission, parce qu'elles ont lieu dans un sous-processus. L'interrupteur
    // du pane est donc le seul point de controle humain entre un prompt ecrit
    // par un modele et les fichiers du depot.
    //
    // Il est lu ICI, au moment de l'appel, et le booleen qui en sort est fige
    // dans `spec`. Un job de fond ne le relit jamais : sinon une delegation
    // partie en lecture seule se mettrait a ecrire parce que l'interrupteur a
    // ete arme entre l'appel et le lancement effectif.
    const mayWrite = Boolean(e.writeFiles) && writeArmed
    if (e.writeFiles && !writeArmed) {
      await $.ui.open({ id: PANE, title: 'opencode' })
      $.ui.toast("opencode: l'ecriture est desarmee")
      return {
        result:
          "L'ecriture n'est pas armee : rien ne s'est execute. L'utilisateur arme l'ecriture lui-meme, " +
          "dans le pane `/opencode`, avec l'interrupteur a cote du selecteur de modele ; il se desarme a " +
          'chaque nouvelle session. Lui demander de l\'armer, puis rappeler cet outil. Sans ecriture, la ' +
          'meme tache tourne en lecture seule en retirant `writeFiles`.',
      }
    }

    const spec = {
      prompt: String(e.prompt || ''),
      model: e.model || defaultModel,
      timeoutMs: Math.min(Number(e.budgetMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      mayWrite,
      // En lecture seule, l'agent `plan` est impose : un `agent` libre choisi
      // par Claude rouvrirait l'ecriture par la porte de derriere
      agent: mayWrite ? e.agent : PLAN_AGENT,
      dir: e.dir,
      resume: e.resume || null,
      isBackground,
    }

    if (!isBackground) return runDelegation($, spec, next)

    // Le repertoire de la session se lit dans le hook : un minuteur qui survit
    // a son hook lirait celui de la session au moment ou il tourne
    if (!spec.dir) {
      try {
        spec.sessionCwd = (await $.session.cwd()) || null
      } catch {
        spec.sessionCwd = null
      }
    }

    const job = {
      // une cle qu'un autre chargement du module ne redonnera pas : le balayage
      // des orphelins s'en sert pour ne pas reprendre un job encore en vol
      key: 'job-' + Date.now() + '-' + ++jobSeq,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
      savedAt: Date.now(),
      prompt: spec.prompt,
      model: spec.model,
      agent: spec.agent,
      mayWrite,
      timeoutMs: spec.timeoutMs,
      sessionId: spec.resume,
      dir: spec.dir || spec.sessionCwd || null,
    }
    liveJobs.set(job.key, job)
    await saveJobs($)

    // Le travail part dans un rappel de minuteur, qui tourne hors de tout
    // evenement : le hook rend la main tout de suite, et l'orchestrateur reste
    // disponible pendant qu'opencode travaille.
    $.clock.after(0, async () => {
      let report
      try {
        const out = await runDelegation($, spec, null, job)
        report = out.result
      } catch (err) {
        report =
          'La delegation de fond a echoue dans le mod, avant ou apres opencode : ' +
          ((err && err.message) || 'cause inconnue') +
          '. Rien ne garantit que la tache n\'a pas tourne : regarder le pane `/opencode` avant de relancer.'
      }
      liveJobs.delete(job.key)
      await saveJobs($)
      notify($, report)
    })

    return { result: launched(spec) }
  }).catch(async ($, e, next) => {
    // Sans ce gestionnaire, un hook qui echoue est simplement saute et l'outil
    // reste sans reponse : on rend l'echec lisible pour Claude
    const why = (next.error && next.error.message) || 'cause inconnue'
    return { result: 'opencode-delegate a echoue avant de lancer la tache: ' + why }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Select, Input, Button } = $.ui.resolve(e)
    const width = (e.props && e.props.bodyColumns) || 48
    // une carte mange deux colonnes de bordure et deux de padding
    const inner = Math.max(width - 4, 12)
    const redraw = () => $.ui.invalidate('ui.render')

    // Sans opencode, ni selecteur de modele ni liste vide : le pane dit ce qui
    // manque, puisque c'est la seule chose que l'utilisateur peut y faire
    if (!opencode.isReady) {
      return Box({
        flexDirection: 'column',
        rowGap: 1,
        children: [
          Text({ key: 'off', color: 'red', children: ['Delegation indisponible'] }),
          Text({ key: 'why', wrap: 'wrap', children: [opencode.reason] }),
          Text({ key: 'fix', dimColor: true, wrap: 'wrap', children: [FIX] }),
        ],
      })
    }

    const choices = modelChoices()
    const picker = Select({
      key: 'model',
      label: 'Modele',
      options: choices.map((m) => ({ value: m, label: m })),
      value: defaultModel,
      onSelect: async (value) => {
        defaultModel = value
        rememberModel(value)
        notice = null
        redraw()
        await saveModels($)
      },
    })

    const field = Input({
      key: 'model-input',
      label: 'Autre',
      placeholder: catalog ? 'provider/model (' + catalog.length + ' au catalogue)' : 'provider/model',
      value: '',
      submitLabel: 'definir',
      onSubmit: async (value) => {
        const wanted = String(value || '').trim()
        if (!wanted) return
        if (catalog && !catalog.includes(wanted)) {
          notice = 'modele absent de `opencode models` : ' + wanted
          redraw()
          return
        }
        defaultModel = wanted
        rememberModel(wanted)
        notice = null
        redraw()
        await saveModels($)
      },
    })

    // L'etat de l'ecriture est toujours visible, et se bascule d'un clic : c'est
    // le seul point de controle entre un prompt ecrit par un modele et les
    // fichiers du depot, il ne doit pas etre cache dans un menu
    const writeSwitch = Button({
      key: 'write-toggle',
      label: writeArmed ? 'Ecriture  armee' : 'Ecriture  desarmee',
      plain: true,
      dimColor: !writeArmed,
      onPress: () => {
        writeArmed = !writeArmed
        redraw()
      },
    })

    const header = Box({
      key: 'header',
      flexDirection: 'column',
      rowGap: 1,
      children: [
        picker,
        field,
        writeSwitch,
        ...(notice ? [Text({ key: 'notice', color: 'red', children: [fit(notice, width)] })] : []),
      ],
    })

    if (tasks.length === 0) {
      return Box({
        flexDirection: 'column',
        rowGap: 1,
        children: [header, Text({ dimColor: true, children: ['Aucune tache pour le moment.'] })],
      })
    }

    // Une carte par tache ; la bordure porte le statut, de la meme epaisseur
    // partout pour que seule la couleur distingue les etats
    const card = (task) => {
      const isRunning = task.status === 'running'
      // Ni bordure coloree ni glyphe : la section dit deja si la tache tourne,
      // et le seul etat qui doit sauter aux yeux est l'echec. Il passe donc par
      // le titre, en rouge.
      const failed = task.status === 'failed'
      const model = shortModel(task.model)
      // La duree de la session entiere, et rien d'autre : le budget restant ne
      // fait qu'inquieter, puisqu'une coupure se reprend par `resume`
      const time = duration(task)
      const head = task.title || model
      // La seconde ligne dit le modele et ce qu'il a consomme. Le reste n'y
      // apparait qu'a l'exception pres : une ecriture, ou un arret subi.
      const meta = [
        model,
        tokens(task),
        task.mayWrite ? 'ecriture' : null,
        // une tache de fond ne rend rien a l'appel qui l'a lancee : le dire sur
        // la carte, c'est dire ou son resultat va arriver
        task.isBackground ? 'fond' : null,
        task.stop ? STOPS[task.stop].word : null,
      ]
        .filter(Boolean)
        .join('  ')

      // En cours, le journal vient de la session et couvre tous ses segments ;
      // finie, c'est la liste accumulee qui fait foi
      const calls = (isRunning ? task.liveCalls : null) || task.toolCalls || []
      const isOpen = openCalls[task.id]
      const history = [
        calls.length + (calls.length > 1 ? ' appels' : ' appel'),
        task.runs > 1 ? task.runs + ' reprises' : null,
        task.cuts ? task.cuts + (task.cuts > 1 ? ' coupures' : ' coupure') : null,
      ]
        .filter(Boolean)
        .join(' \u00b7 ')

      // Le detail des appels, replie par defaut comme les sous-taches du
      // panneau natif
      const rows = !isOpen
        ? []
        : calls.slice(0, 12).map((call, index) => {
            const span = call.ms == null ? '' : call.ms < 1000 ? call.ms + 'ms' : clock(Math.round(call.ms / 1000))
            return Box({
              key: 'call-' + task.id + '-' + index,
              flexDirection: 'row',
              justifyContent: 'space-between',
              columnGap: 1,
              children: [
                Text({ dimColor: true, children: [fit(call.title || call.tool, Math.max(inner - span.length - 4, 8))] }),
                Text({ dimColor: true, children: [span] }),
              ],
            })
          })
      if (isOpen && calls.length > 12) {
        rows.push(
          Text({ key: 'call-more-' + task.id, dimColor: true, children: ['\u2026 et ' + (calls.length - 12) + ' autres'] }),
        )
      }

      return Box({
        key: 'task-' + task.id,
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'gray',
        paddingX: 1,
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 1,
            children: [
              Text({
                color: failed ? 'red' : undefined,
                children: [fit(head, Math.max(inner - time.length - 2, 8))],
              }),
              Text({ dimColor: true, children: [time] }),
            ],
          }),
          Text({ dimColor: true, children: [fit(meta, inner)] }),
          ...(calls.length
            ? [
                Button({
                  key: 'calls-' + task.id,
                  label: history + ' ' + (isOpen ? '\u2304' : '\u203a'),
                  plain: true,
                  dimColor: true,
                  onPress: () => {
                    openCalls[task.id] = !openCalls[task.id]
                    redraw()
                  },
                }),
                ...rows,
              ]
            : []),
        ],
      })
    }

    // Un en-tete cliquable qui plie ou deplie sa liste
    const section = (id, label, list, hotkey) => {
      if (list.length === 0) return null
      const isFolded = folded[id]
      const head = Button({
        key: 'fold-' + id,
        label: label + ' ' + list.length + ' ' + (isFolded ? '\u203a' : '\u2304'),
        hotkey,
        plain: true,
        onPress: () => {
          folded[id] = !folded[id]
          redraw()
        },
      })
      return Box({
        key: 'section-' + id,
        flexDirection: 'column',
        // une ligne vide sous l'en-tete, une autre sous la derniere carte
        rowGap: 1,
        children: isFolded
          ? [head]
          : [
              head,
              Box({
                key: 'cards-' + id,
                flexDirection: 'column',
                // une ligne vide entre deux cartes, et une sous la derniere
                rowGap: 1,
                marginBottom: 1,
                children: list.slice(0, 10).map(card),
              }),
            ],
      })
    }

    const runningTasks = tasks.filter((t) => t.status === 'running')
    const finishedTasks = tasks.filter((t) => t.status !== 'running')
    const spent = tasks.reduce((sum, t) => sum + (t.cost || 0), 0)

    const totals = [
      tasks.length + (tasks.length > 1 ? ' taches' : ' tache'),
      spent ? money(spent) : null,
    ]
      .filter(Boolean)
      .join(' \u00b7 ')

    return Box({
      flexDirection: 'column',
      rowGap: 1,
      children: [
        header,
        section('running', 'En cours', runningTasks, 'e'),
        section('done', 'Terminees', finishedTasks, 't'),
        Text({ dimColor: true, children: [totals] }),
      ].filter(Boolean),
    })
  })
}
