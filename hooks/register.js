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

// Le palier gratuit d'OpenCode Console refuse une session dont l'id n'a pas ete
// emis par opencode : il lit un id invente comme un appel « hors d'OpenCode »
// et repond 403 FreeTierError. On fait donc creer la session par le serveur,
// ce qui donne un id authentique tout en le connaissant avant le run.
async function createSession($, title) {
  try {
    const made = await $.process.run(
      ['opencode', 'api', 'session.create', '-d', JSON.stringify({ title })],
      { timeoutMs: 15_000 },
    )
    if (made.exitCode !== 0) return null
    const body = JSON.parse(made.stdout)
    const info = body.data || body
    return typeof info.id === 'string' && info.id ? info.id : null
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
      errors.push((event.error && event.error.message) || 'erreur opencode sans message')
    }
  }

  return { text: [...texts.values()].join('\n').trim(), toolCalls, errors, sessionId }
}

function elapsed(task) {
  const end = task.endedAt || Date.now()
  return Math.round((end - task.startedAt) / 1000)
}

// 8s, 1m12, 11m05
function duration(task) {
  const total = elapsed(task)
  if (total < 60) return total + 's'
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return minutes + 'm' + seconds
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

    await $.tool.register({
      name: 'delegate',
      description: [
        'Delegue une tache autonome a opencode, un autre agent de code qui tourne',
        'sur ses propres modeles (moins chers que ceux de cette session).',
        'A utiliser pour une tache bien delimitee et descriptible en texte :',
        'exploration, refactor mecanique, ecriture de tests, resume de code.',
        'opencode travaille dans le meme depot et ECRIT dans les fichiers, avec',
        'les permissions auto-approuvees : ne pas deleguer une tache dont le',
        'perimetre de fichiers est flou.',
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
          model: {
            type: 'string',
            description:
              "Modele au format provider/model. Par defaut, celui choisi dans le pane /opencode.",
          },
          agent: { type: 'string', description: "Agent opencode a utiliser, par exemple 'plan'." },
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

    try {
      await $.command.register({
        name: 'opencode',
        description: 'Ouvre le pane opencode : taches en cours et choix du modele',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('commande /opencode non enregistree: ' + err.message)
    }

    // Le catalogue sert a valider une saisie libre ; il peut arriver en retard
    $.clock.after(0, async () => {
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
        'Il travaille dans le meme depot et ecrit dans les fichiers, donc ne pas',
        'lui confier une tache dont le perimetre de fichiers est flou.',
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
    // Sans id, la tache tourne quand meme : on le lira dans le flux a la fin,
    // au prix du suivi live
    const sessionId = e.resume || (await createSession($, prompt.slice(0, 60)))

    const task = {
      id: ++seq,
      prompt,
      model,
      agent: e.agent,
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

    const poll = !sessionId ? null : $.clock.every(POLL_MS, async () => {
      try {
        const probe = await $.process.run(
          ['opencode', 'api', 'session.get', '--param', 'sessionID=' + sessionId],
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

    const argv = ['opencode', 'run', '--format', 'json', '--auto', '-m', model]
    if (sessionId) argv.push('--session', sessionId)
    if (e.agent) argv.push('--agent', e.agent)
    argv.push(task.prompt)

    const init = { timeoutMs }
    if (e.dir) init.cwd = e.dir

    let run
    try {
      run = await $.process.run(argv, init)
    } catch (err) {
      if (poll) poll.cancel()
      task.status = 'failed'
      task.endedAt = Date.now()
      task.error = err.message
      $.ui.invalidate('ui.render')
      $.ui.toast('opencode: echec')
      return { result: "opencode n'a pas pu finir la tache: " + err.message }
    }
    if (poll) poll.cancel()

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
      const color = isRunning ? 'blue' : task.status === 'done' ? 'green' : 'red'
      const metrics = [duration(task), money(task.cost)].filter(Boolean).join('  ')
      const room = Math.max(inner - metrics.length - 2, 8)
      return Box({
        key: 'task-' + task.id,
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: color,
        paddingX: 1,
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  Text({ color, children: [mark] }),
                  Text({ children: [fit(shortModel(task.model), room)] }),
                ],
              }),
              Text({ dimColor: true, children: [metrics] }),
            ],
          }),
          Text({ dimColor: true, children: [fit(task.title || task.prompt, inner)] }),
        ],
      })
    }

    // Un en-tete cliquable qui plie ou deplie sa liste
    const section = (id, label, list, hotkey) => {
      if (list.length === 0) return null
      const isFolded = folded[id]
      const head = Button({
        key: 'fold-' + id,
        label: (isFolded ? '\u25b8 ' : '\u25be ') + label + ' (' + list.length + ')',
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
