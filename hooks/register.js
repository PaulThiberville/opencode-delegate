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

// Les libelles de la question d'autorisation. `$.ui.ask` rend le libelle choisi
// tel quel, donc on les compare a l'identique.
const ALLOW = "Autoriser l'ecriture"
const READ_ONLY = 'Lecture seule'
const CANCEL = 'Annuler'

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
// Ce que le preflight a trouve ; `reason` est deja une phrase pour l'utilisateur
let opencode = { isReady: false, version: null, reason: "opencode n'a pas encore ete sonde" }
// Quand la question d'autorisation d'ecriture en cours a ete posee, 0 s'il n'y
// en a pas. Le moteur ne tient qu'un AskUserQuestion a la fois : deux `$.ui.ask`
// lances coup sur coup, et le second revient en refus sans que personne ait rien
// refuse. Une date plutot qu'un booleen parce qu'un hook tue en pleine question
// ne remet rien a zero : au-dela de STALE_ASK_MS le drapeau est tenu pour
// perime, sinon une seule tache morte interdirait l'ecriture pour tout le
// processus.
let askingSince = 0
const STALE_ASK_MS = 900_000

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
        const status = (part.state || {}).status
        if (name) mine.push(status && status !== 'completed' ? name + ' (' + status + ')' : name)
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
          "l'utilisateur est alors interroge et doit autoriser l'ecriture lui-meme,",
          "sans quoi la delegation n'a pas lieu. Ne pas passer `writeFiles` pour",
          'une tache dont le perimetre de fichiers est flou.',
          'Une seule delegation en ecriture a la fois : le moteur ne tient',
          "qu'une question a la fois, donc deux appels `writeFiles` dans le meme",
          'tour font refuser le second. Les delegations en lecture seule, elles,',
          'peuvent partir en parallele.',
          "L'outil rend la reponse finale d'opencode, plus l'id de session a passer",
          'dans `resume` pour un suivi sur la meme conversation opencode, le',
          'repertoire ou la tache a tourne et le commit de depart.',
          "Quand la tache s'arrete sans conclure, le resultat dit pourquoi",
          '(budget epuise, tour abandonne, erreur de fournisseur, demarrage',
          "impossible) et rend quand meme ce qu'opencode avait deja produit,",
          "relu dans sa session, plus l'id a repasser dans `resume` pour",
          'reprendre la. Le budget plafonne un appel, pas une tache : une tache',
          'longue se mene en plusieurs reprises sur la meme session opencode.',
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
                "A passer a true seulement si la tache doit modifier des fichiers. L'utilisateur est alors interroge et doit autoriser l'ecriture ; s'il refuse ou ne repond pas, rien ne part. Sans ce champ, la tache tourne en lecture seule. Une seule a la fois : un second appel avec `writeFiles` pendant qu'une question attend est refuse d'office.",
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
        'ecrire, passer `writeFiles: true` : la question part a l\'utilisateur, qui',
        "autorise ou non ; sans son accord, rien ne tourne. Ne pas le passer pour",
        'une tache dont le perimetre de fichiers est flou. Une seule delegation en',
        'ecriture a la fois : deux questions lancees dans le meme tour font refuser',
        'la seconde.',
        '',
        "Le resultat nomme le repertoire effectif, le commit de depart et l'etat du",
        "checkout. Quand la tache est coupee, il dit pourquoi et rend quand meme ce",
        "qu'opencode avait deja produit.",
      ].join('\n'),
    }
    return { blocks: [...below.blocks, block] }
  })

  on('command.run', { command: 'opencode' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'opencode', focus: true, closeOnEscape: true })
    return {}
  })

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const model = e.model || defaultModel
    const timeoutMs = Math.min(Number(e.budgetMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const prompt = String(e.prompt || '')

    // `next.signal` s'abat quand l'evenement est abandonne : c'est a ca qu'on
    // reconnait un tour interrompu d'un budget epuise, deux causes qui ne se
    // traitent pas pareil.
    let isAbandoned = false
    try {
      if (next.signal.aborted) isAbandoned = true
      else next.signal.addEventListener('abort', () => { isAbandoned = true }, { once: true })
    } catch {
      // pas de signal sur ce build : on ne distinguera pas l'abandon
    }

    // L'ecriture n'est jamais implicite : Claude la demande, l'utilisateur la
    // donne. `$.ui.ask` rejette si la question est ecartee et dans un `claude -p`,
    // ou personne ne peut repondre ; dans les deux cas rien ne part.
    let mayWrite = false
    if (e.writeFiles) {
      // Le moteur ne tient qu'un AskUserQuestion a la fois. Deux delegations en
      // ecriture lancees dans le meme tour, et la seconde question revient en
      // refus sans que personne ait rien refuse : on la refuse nous-memes, en
      // disant quoi faire, plutot que de laisser Claude lire un faux « non ».
      if (askingSince && Date.now() - askingSince < STALE_ASK_MS) {
        return {
          result:
            "Une autre delegation attend deja que l'utilisateur autorise l'ecriture, et le moteur ne tient " +
            "qu'une question a la fois. Rien ne s'est execute. Une seule delegation en ecriture a la fois : " +
            'attendre le resultat de la premiere, puis rappeler cet outil.',
        }
      }
      const where = e.dir ? ' dans ' + e.dir : ''
      let answer
      askingSince = Date.now()
      try {
        answer = await $.ui.ask(
          'Laisser opencode ecrire dans les fichiers' + where + ' pour « ' + fit(prompt, 80) + ' » ?',
          { options: [ALLOW, READ_ONLY, CANCEL], header: 'opencode' },
        )
      } catch (err) {
        askingSince = 0
        return {
          result:
            "La delegation demandait d'ecrire dans les fichiers, et personne n'a pu l'autoriser (" +
            err.message +
            '). Rien ne s\'est execute. Relancer sans `writeFiles` pour une tache en lecture seule.',
        }
      }
      askingSince = 0
      if (answer === ALLOW) mayWrite = true
      else if (answer !== READ_ONLY) {
        return {
          result:
            "L'utilisateur n'a pas autorise l'ecriture (reponse : " +
            answer +
            "). Rien ne s'est execute.",
        }
      }
    }
    // Une session reprise existe deja, avec le repertoire ou elle est nee ; une
    // nouvelle sera creee par `opencode run` lui-meme, puis retrouvee
    const sessionId = e.resume || null

    // Ou et sur quoi la tache va tourner, avant de la lancer : `pwd` resout un
    // `dir` relatif en absolu, ce qui donne aussi de quoi reconnaitre la session
    // a suivre dans `session.list`.
    const checkout = await probeCheckout($, e.dir)
    let targetDir = checkout.dir
    if (!targetDir) {
      try {
        targetDir = e.dir ? null : (await $.session.cwd()) || null
      } catch {
        targetDir = null
      }
    }

    // En lecture seule, l'agent `plan` est impose : un `agent` libre choisi par
    // Claude rouvrirait l'ecriture par la porte de derriere
    const agent = mayWrite ? e.agent : PLAN_AGENT

    // Une reprise continue la meme carte : l'unite affichee est la session
    // opencode, pas l'appel d'outil. Deux cartes au meme titre ne disaient rien
    // de plus que « c'est la meme conversation ».
    const resumed = e.resume ? tasks.find((item) => item.sessionId === e.resume) : null
    const task = resumed || { id: ++seq, toolCalls: [], segments: [], runs: 0, cuts: 0, cost: 0, tokens: null }
    Object.assign(task, {
      prompt,
      model,
      agent,
      mayWrite,
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

    await $.ui.open({ id: PANE, title: 'opencode' })
    $.ui.invalidate('ui.render')

    let watched = sessionId
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
      $.ui.invalidate('ui.render')
    })

    // `--auto` auto-approuve tout ce qui n'est pas explicitement refuse : il ne
    // sort que pour une ecriture autorisee a l'instant par l'utilisateur. En
    // lecture seule, l'agent `plan` n'a pas d'outil d'ecriture et rien a approuver.
    const argv = ['opencode', 'run', '--format', 'json', '-m', model]
    if (mayWrite) argv.push('--auto')
    if (e.resume) argv.push('--session', e.resume)
    if (agent) argv.push('--agent', agent)
    argv.push(task.prompt)

    const init = { timeoutMs }
    if (e.dir) init.cwd = e.dir

    // Ou et sur quoi la tache a tourne : la ligne que personne n'avait, et sans
    // laquelle un checkout en retard produit une conclusion fausse sans trace
    const whereLine =
      'ou: ' +
      [
        checkout.dir || '(repertoire inconnu)',
        checkout.commit ? '@ ' + checkout.commit : '(hors depot git)',
        checkout.branch ? '(' + checkout.branch + ')' : null,
        checkout.commit ? (checkout.isDirty ? 'checkout sale' : 'checkout propre') : null,
      ]
        .filter(Boolean)
        .join(' ')
    const behindLine = checkout.behind
      ? '/!\\ ce checkout est ' +
        checkout.behind +
        " commit(s) derriere son amont : la tache a lu un etat en retard. Peser la conclusion en consequence, et verifier sur un checkout a jour avant d'en tirer quoi que ce soit."
      : null

    const footer = () =>
      [
        task.sessionId ? 'session opencode: ' + task.sessionId : null,
        'modele: ' + model,
        'mode: ' + (mayWrite ? 'ecriture autorisee par l\'utilisateur' : 'lecture seule (agent plan)'),
        'duree: ' + duration(task),
        task.cost ? 'cout: ' + money(task.cost) : null,
        task.toolCount ? 'outils: ' + task.toolCount + ' appels' : null,
      ]
        .filter(Boolean)
        .join(' · ')

    // Le plafond de dix minutes porte sur un appel de `$.process.run`, pas sur
    // une tache : la session opencode, elle, garde son historique. Un echec qui
    // ne rend pas son id casse la chaine — Claude n'a plus de quoi reprendre, et
    // une tache longue a l'air hors de portee du mod alors qu'elle se mene en
    // plusieurs reprises. On le dit donc explicitement, et on dit aussi quand il
    // n'y a pas d'id, pour ne pas laisser croire a une reprise possible.
    const resumeLine = () =>
      task.sessionId
        ? 'Reprise possible : rappeler cet outil avec `resume: "' +
          task.sessionId +
          '"` continue dans la meme session opencode, qui garde tout son historique. Le budget plafonne un appel, pas une tache : une tache longue se mene en plusieurs reprises.'
        : "Pas de reprise possible : la session opencode n'a pas ete retrouvee, donc pas d'id a passer dans `resume`. Il faudrait relancer la tache depuis le debut."

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
      if (!found && !e.resume) found = await findSession($, task.startedAt - 2_000, targetDir)
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
        body.push('', 'Outils appeles avant l\'arret : ' + partial.tools.join(', '))
      }
      body.push('', resumeLine())
      body.push('', '---', footer(), whereLine)
      if (behindLine) body.push(behindLine)

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
      const stop = isAbandoned || isAborted(next) ? 'abandoned' : isOutOfBudget ? 'budget' : 'start'
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
      body.push('', resumeLine())
      body.push('', '---', footer(), whereLine)
      if (behindLine) body.push(behindLine)
      return { result: body.join('\n') }
    }

    task.status = 'done'
    $.ui.invalidate('ui.render')
    $.ui.toast('opencode: termine en ' + duration(task))

    const answer = parsed.text || '(opencode a fini sans texte de reponse)'
    const tail = ['', '---', footer(), whereLine]
    if (behindLine) tail.push(behindLine)
    return { result: answer + tail.join('\n') }
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

    const header = Box({
      key: 'header',
      flexDirection: 'column',
      rowGap: 1,
      children: [
        picker,
        field,
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
      const mark = isRunning ? '\u25b8' : task.status === 'done' ? '\u2713' : '\u2717'
      // La bordure est neutre, comme dans le panneau des taches en arriere-plan :
      // le statut tient dans le glyphe et dans la section qui porte la carte.
      // Le glyphe garde sa couleur, seul signe qui distingue un echec d'une
      // reussite dans la liste des terminees.
      const color = isRunning ? 'blue' : task.status === 'done' ? 'green' : 'red'
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
        task.stop ? STOPS[task.stop].word : null,
      ]
        .filter(Boolean)
        .join('  ')

      const calls = task.toolCalls || []
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
              Text({ children: [fit(head, Math.max(inner - time.length - 2, 8))] }),
              Text({ dimColor: true, children: [time] }),
            ],
          }),
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color, children: [mark] }),
              Text({ dimColor: true, children: [fit(meta, inner - 2)] }),
            ],
          }),
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
