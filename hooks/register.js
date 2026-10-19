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
// Ce que le preflight a trouve ; `reason` est deja une phrase pour l'utilisateur
let opencode = { isReady: false, version: null, reason: "opencode n'a pas encore ete sonde" }
// Vrai tant qu'une question d'autorisation d'ecriture attend une reponse. Le
// moteur ne tient qu'un AskUserQuestion a la fois : deux `$.ui.ask` lances coup
// sur coup, et le second revient en refus sans que personne ait rien refuse.
let isAsking = false

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
  const toolCalls = []
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
      const status = (part.state && part.state.status) || 'unknown'
      toolCalls.push({ tool: part.tool, status })
    } else if (event.type === 'error') {
      const error = event.error || {}
      errors.push({
        type: typeof error.type === 'string' ? error.type : '',
        message: error.message || 'erreur opencode sans message',
      })
    }
  }

  return { text: [...texts.values()].join('\n').trim(), toolCalls, errors, sessionId }
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
  const tools = []
  for (const message of items) {
    if (!message) continue
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
        if (name) tools.push(status && status !== 'completed' ? name + ' (' + status + ')' : name)
      }
    }
  }
  // les outils ont ete collectes a l'envers du temps
  tools.reverse()
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

// 8s, 1m12, 11m05
function clock(total) {
  if (total < 60) return total + 's'
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return minutes + 'm' + seconds
}

function elapsed(task) {
  const end = task.endedAt || Date.now()
  return Math.round((end - task.startedAt) / 1000)
}

function duration(task) {
  return clock(elapsed(task))
}

// Ce qu'il reste de budget a une tache en cours, pour voir venir la coupe au
// lieu de la subir. Vide une fois la tache finie : le budget ne veut plus rien
// dire, et la duree est deja la.
function remaining(task) {
  if (task.status !== 'running' || !task.timeoutMs) return ''
  const left = Math.round((task.startedAt + task.timeoutMs - Date.now()) / 1000)
  return 'reste ' + clock(Math.max(left, 0))
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
          "L'outil rend la reponse finale d'opencode, plus l'id de session a passer",
          'dans `resume` pour un suivi sur la meme conversation opencode.',
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
                "A passer a true seulement si la tache doit modifier des fichiers. L'utilisateur est alors interroge et doit autoriser l'ecriture ; s'il refuse ou ne repond pas, rien ne part. Sans ce champ, la tache tourne en lecture seule.",
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
                'Repertoire de travail de la tache, absolu ou relatif a la session. Par defaut celui de la session.',
            },
            resume: {
              type: 'string',
              description:
                "Id de session opencode rendu par un appel precedent, pour continuer la meme conversation.",
            },
            budgetMs: {
              type: 'number',
              description: 'Budget de temps en millisecondes, 300000 par defaut, 600000 au maximum.',
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
        'une tache dont le perimetre de fichiers est flou.',
      ].join('\n'),
    }
    return { blocks: [...below.blocks, block] }
  })

  on('command.run', { command: 'opencode' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'opencode', focus: true, closeOnEscape: true })
    return {}
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const model = e.model || defaultModel
    const timeoutMs = Math.min(Number(e.budgetMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const prompt = String(e.prompt || '')

    // L'ecriture n'est jamais implicite : Claude la demande, l'utilisateur la
    // donne. `$.ui.ask` rejette si la question est ecartee et dans un `claude -p`,
    // ou personne ne peut repondre ; dans les deux cas rien ne part.
    let mayWrite = false
    if (e.writeFiles) {
      const where = e.dir ? ' dans ' + e.dir : ''
      let answer
      try {
        answer = await $.ui.ask(
          'Laisser opencode ecrire dans les fichiers' + where + ' pour « ' + fit(prompt, 80) + ' » ?',
          { options: [ALLOW, READ_ONLY, CANCEL], header: 'opencode' },
        )
      } catch (err) {
        return {
          result:
            "La delegation demandait d'ecrire dans les fichiers, et personne n'a pu l'autoriser (" +
            err.message +
            '). Rien ne s\'est execute. Relancer sans `writeFiles` pour une tache en lecture seule.',
        }
      }
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
    // Sur quoi reconnaitre la session a suivre : le repertoire vise, quand on
    // peut le nommer en absolu
    let targetDir = null
    try {
      const base = await $.session.cwd()
      targetDir = !e.dir ? base || null : e.dir.startsWith('/') ? e.dir : null
    } catch {
      targetDir = null
    }

    // En lecture seule, l'agent `plan` est impose : un `agent` libre choisi par
    // Claude rouvrirait l'ecriture par la porte de derriere
    const agent = mayWrite ? e.agent : PLAN_AGENT

    const task = {
      id: ++seq,
      prompt,
      model,
      agent,
      mayWrite,
      sessionId,
      status: 'running',
      startedAt: Date.now(),
      cost: 0,
      tokens: null,
      lastTool: null,
      toolCount: 0,
    }
    tasks.unshift(task)

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

    let run
    try {
      run = await $.process.run(argv, init)
    } catch (err) {
      poll.cancel()
      task.status = 'failed'
      task.endedAt = Date.now()
      task.error = err.message
      $.ui.invalidate('ui.render')
      $.ui.toast('opencode: echec')
      return { result: "opencode n'a pas pu finir la tache: " + err.message }
    }
    poll.cancel()

    const parsed = parseEvents(run.stdout)
    task.endedAt = Date.now()
    if (!task.sessionId && parsed.sessionId) task.sessionId = parsed.sessionId
    task.toolCount = parsed.toolCalls.length
    task.lastTool = parsed.toolCalls.length ? parsed.toolCalls[parsed.toolCalls.length - 1].tool : null
    task.status = parsed.errors.length || run.exitCode !== 0 ? 'failed' : 'done'
    $.ui.invalidate('ui.render')
    $.ui.toast(
      'opencode: ' + (task.status === 'done' ? 'termine' : 'echec') + ' en ' + duration(task),
    )

    const footer = [
      task.sessionId ? 'session opencode: ' + task.sessionId : null,
      'modele: ' + model,
      'mode: ' + (mayWrite ? 'ecriture autorisee par l\'utilisateur' : 'lecture seule (agent plan)'),
      'duree: ' + duration(task),
      task.cost ? 'cout: ' + money(task.cost) : null,
      parsed.toolCalls.length ? 'outils: ' + parsed.toolCalls.length + ' appels' : null,
    ]
      .filter(Boolean)
      .join(' · ')

    if (task.status === 'failed') {
      const why = parsed.errors.join(' | ') || run.stderr.trim() || 'code de sortie ' + run.exitCode
      return { result: 'opencode a echoue: ' + why + '\n\n' + footer }
    }

    const answer = parsed.text || '(opencode a fini sans texte de reponse)'
    return { result: answer + '\n\n---\n' + footer }
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
      // Ce que la tache avait le droit de faire, lisible d'un coup d'oeil
      const scope = task.mayWrite ? 'ecriture' : 'lecture'
      const time = duration(task)
      const head = task.title || model
      const meta = [task.title ? model : null, scope, money(task.cost)].filter(Boolean).join('  ')
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
