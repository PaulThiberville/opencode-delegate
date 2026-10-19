import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__opencode-delegate__delegate'

// Le flux NDJSON reel d'un `opencode run --format json`, abrege
const RUN_STDOUT = [
  '{"type":"step_start","timestamp":1,"sessionID":"SID","part":{"id":"p0","type":"step-start"}}',
  '{"type":"tool_use","timestamp":2,"sessionID":"SID","part":{"id":"p1","type":"tool","tool":"read","state":{"status":"completed","input":{"path":"a.txt"},"output":"1: hello"}}}',
  '{"type":"step_finish","timestamp":3,"sessionID":"SID","part":{"id":"p2","type":"step-finish"}}',
  '{"type":"text","timestamp":4,"sessionID":"SID","part":{"id":"p3","type":"text","text":"hello"}}',
].join('\n')

const SESSION_GET = JSON.stringify({
  data: { id: 'SID', cost: 0.00039259, tokens: { input: 518, output: 334 }, title: 'Lecture de a.txt' },
})

const CATALOG = ['ollama-cloud/gpt-oss:20b', 'ollama-cloud/kimi-k2.7-code', 'opencode/claude-haiku-5-5'].join('\n')

// Un id tel que le serveur opencode l'emet ; un id invente fait repondre 403
// FreeTierError au palier gratuit d'OpenCode Console
const SERVER_SID = 'ses_eac681071ffewObMBj6e5N7Ykt'
let listFinds = true

// Ce que `opencode --version` repond, et ce que l'utilisateur repond a la
// question d'autorisation d'ecriture ; chaque test peut les changer
const ALLOW = "Autoriser l'ecriture"
let version = 'opencode v2.0.32'
let askAnswer = ALLOW

const PANE = {
  plugin: 'opencode-delegate',
  component: 'Pane',
  requestId: 'opencode-delegate',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'opencode',
    isFocused: true,
    bodyColumns: 48,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

// Branche les reponses du moteur et rend de quoi inspecter ce qui s'est passe
function stubEngine(on: any, clock: any, saved: Map<string, unknown>) {
  listFinds = true
  version = 'opencode v2.0.32'
  askAnswer = ALLOW
  const argvs: string[][] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  // sert de temoin : si le moteur dessine, c'est que notre arbre a ete refuse
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  // L'autorisation d'ecriture passe par `$.ui.ask`, que le moteur sert comme un
  // appel a AskUserQuestion. Par defaut la question est autorisee.
  on('tool.call', ($: any, e: any) => {
    const question = e.questions[0].question
    return { result: { answers: { [question]: askAnswer } } }
  })
  on('process.run', async ($: any, e: any) => {
    const argv: string[] = e.argv
    argvs.push(argv)
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: version, stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: CATALOG, stderr: '' } }
    if (argv[2] === 'session.list') {
      const items = listFinds
        ? [{ id: SERVER_SID, time: { created: Date.now() }, location: { directory: '/work' } }]
        : []
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: items }), stderr: '' } }
    }
    if (argv[1] === 'api') return { value: { exitCode: 0, stdout: SESSION_GET, stderr: '' } }
    // la tache elle-meme prend cinq secondes de temps simule
    await clock.sleep(5000)
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })
  return argvs
}

async function runTask($: any, clock: any, args: Record<string, unknown> = {}) {
  const pending = $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', ...args })
  await clock.advance(2000) // le timer de suivi interroge la session une fois
  await clock.advance(4000) // puis la tache rend la main
  return pending
}

test("l'outil rend la reponse d'opencode et le pied de page", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stubEngine(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock, { model: 'ollama-cloud/gpt-oss:20b' })

  expect(out.result).toContain('hello')
  expect(out.result).toContain('session opencode: ' + SERVER_SID)
  expect(out.result).toContain('modele: ollama-cloud/gpt-oss:20b')
  expect(out.result).toContain('outils: 1 appels')
})

test('le pane liste la tache terminee, son cout et le total', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stubEngine(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await runTask($, clock, { model: 'ollama-cloud/gpt-oss:20b' })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // la carte a bien ete dessinee par nous, pas par le moteur
    expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
    // le nom court du modele, sans son fournisseur
    expect(await ui.find({ type: 'Text', text: 'gpt-oss:20b' })).toBeDefined()
    // le polling a remonte le cout avant la fin de la tache
    expect(await ui.find({ type: 'Text', text: /1 tache · \$0\.0004/ })).toBeDefined()
    await ui.unmount()
  }
})

test('le modele choisi dans le pane sert aux delegations suivantes', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const saved = new Map<string, unknown>()
  const argvs = stubEngine(on, clock, saved)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle() // le catalogue alimente les options du selecteur

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'model', value: 'ollama-cloud/kimi-k2.7-code' })
  await ui.unmount()

  // le choix survit a la session
  expect(saved.get('defaultModel')).toBe('ollama-cloud/kimi-k2.7-code')

  await runTask($, clock)
  const run = argvs.find((argv) => argv[1] === 'run')
  expect(run).toBeDefined()
  expect(run!.join(' ')).toContain('-m ollama-cloud/kimi-k2.7-code')
})

test('le pane refuse un modele absent du catalogue opencode', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const saved = new Map<string, unknown>()
  stubEngine(on, clock, saved)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle() // laisse le chargement du catalogue s'executer

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'model-input', text: 'provider/inexistant' })
  expect(await ui.find({ type: 'Text', text: /absent de/ })).toBeDefined()
  expect(saved.get('defaultModel')).toBeUndefined()
  await ui.unmount()
})

test("un echec d'opencode est rendu comme un resultat lisible", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const saved = new Map<string, unknown>()
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', ($: any, e: any) => {
    if (e.argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (e.argv[1] !== 'run') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    return {
      value: {
        exitCode: 1,
        stdout:
          '{"type":"error","timestamp":1,"sessionID":"SID","error":{"type":"provider.auth","message":"This API key has expired."}}',
        stderr: '',
      },
    }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })

  expect(out.result).toContain('opencode a echoue')
  expect(out.result).toContain('This API key has expired.')
})

test("la session est creee par opencode run, pas par l'API", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const argvs = stubEngine(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock)

  // une session creee par l'API se verrait imposer le repertoire du service,
  // donc on laisse `opencode run` creer la sienne, ou le cwd est honore
  expect(argvs.some((argv) => argv[2] === 'session.create')).toBe(false)
  const run = argvs.find((argv) => argv[1] === 'run')
  expect(run!.join(' ')).not.toContain('--session')
  // puis on la retrouve pour alimenter le suivi live
  expect(argvs.some((argv) => argv[2] === 'session.list')).toBe(true)
  expect(out.result).toContain('session opencode: ' + SERVER_SID)
})

test("session introuvable dans la liste, l'id vient du flux", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stubEngine(on, clock, new Map())
  listFinds = false

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock)

  // la tache aboutit quand meme ; seul le suivi live a manque
  expect(out.result).toContain('hello')
  expect(out.result).toContain('session opencode: SID')
})

test('une reprise garde sa session et ne la cherche pas', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const argvs = stubEngine(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await runTask($, clock, { resume: SERVER_SID })

  const run = argvs.find((argv) => argv[1] === 'run')
  expect(run!.join(' ')).toContain('--session ' + SERVER_SID)
  expect(argvs.some((argv) => argv[2] === 'session.list')).toBe(false)
})
