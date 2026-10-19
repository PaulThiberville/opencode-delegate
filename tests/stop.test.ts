import { expect, mock, test } from 'claude-code/testing'

// Le bouton d'arret du pane. On ne peut pas tuer le processus — `$.process.run`
// n'en donne aucune prise — alors le bouton interrompt la session opencode et
// libere l'attente. Ce qui se verifie ici : l'arret rend la main avec un compte
// rendu qui dit que ca vient de l'utilisateur, le resultat tardif du processus
// est ignore, et le bouton ne s'affiche pas tant qu'il n'y a rien a interrompre.

const TOOL = 'mcp__opencode-delegate__delegate'
const SESSION = 'sess-claude-1'
const SERVER_SID = 'ses_eac681071ffewObMBj6e5N7Ykt'

const RUN_STDOUT = [
  '{"type":"tool_use","timestamp":2,"sessionID":"SID","part":{"id":"p1","type":"tool","tool":"read","state":{"status":"completed","title":"read a.txt","time":{"start":1000,"end":1420}}}}',
  '{"type":"text","timestamp":4,"sessionID":"SID","part":{"id":"p3","type":"text","text":"a.txt dit bonjour"}}',
].join('\n')

const PROVIDER_ERROR =
  '{"type":"error","timestamp":1,"sessionID":"SID","error":{"type":"provider.auth","message":"This API key has expired."}}'

const SESSION_GET = JSON.stringify({
  data: { id: SERVER_SID, cost: 0.0004, tokens: { input: 10, output: 5 }, title: 'Lecture de a.txt' },
})

const MESSAGES = [
  { id: 'm2', time: { created: 2 }, type: 'idle', outcome: 'failed' },
  {
    id: 'm1',
    time: { created: 1 },
    type: 'assistant',
    content: [
      { type: 'text', text: 'ce que j\'avais lu' },
      { type: 'tool', name: 'read', state: { status: 'completed' } },
    ],
  },
]

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

type Shape = {
  // aucune session a retrouver : rien a interrompre, donc pas de bouton
  noSession?: boolean
  // ce que rend `opencode run` : la sortie nominale, une erreur de fournisseur,
  // ou un rejet du lancement
  run?: 'ok' | 'provider' | 'start'
  // combien de temps simule la tache prend
  runMs?: number
}

function stub(on: any, clock: any, saved: Map<string, unknown>, shape: Shape = {}) {
  const argvs: string[][] = []
  const submitted: string[] = []
  const logs: string[] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: SESSION }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  // sert de temoin : si le moteur dessine, c'est que notre arbre a ete refuse
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  // le compte rendu de fond entre par un prompt a lui : c'est ce que le moteur
  // sert ici, et ce que le test lit
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', async ($: any, e: any) => {
    const argv: string[] = e.argv
    argvs.push(argv)
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    if (argv[0] === 'git') {
      if (argv[1] === 'rev-parse') {
        return { value: { exitCode: 0, stdout: 'abc123def456789\nmain\n', stderr: '' } }
      }
      if (argv[1] === 'status') return { value: { exitCode: 0, stdout: '', stderr: '' } }
      return { value: { exitCode: 1, stdout: '', stderr: '' } }
    }
    if (argv[2] === 'session.message.list') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: MESSAGES }), stderr: '' } }
    }
    if (argv[2] === 'session.list') {
      const data = shape.noSession
        ? []
        : [{ id: SERVER_SID, time: { created: Date.now() }, location: { directory: '/work' } }]
      return { value: { exitCode: 0, stdout: JSON.stringify({ data }), stderr: '' } }
    }
    if (argv[1] === 'api') return { value: { exitCode: 0, stdout: SESSION_GET, stderr: '' } }
    // `opencode run` lui-meme
    if (shape.run === 'start') return { deny: 'spawn opencode ENOENT' }
    await clock.sleep(shape.runMs ?? 5_000)
    if (shape.run === 'provider') return { value: { exitCode: 1, stdout: PROVIDER_ERROR, stderr: '' } }
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })
  return { argvs, submitted, logs, run: () => argvs.filter((argv) => argv[1] === 'run') }
}


// Lance une delegation, laisse le suivi retrouver la session, et rend le pane
async function started($: any, clock: any, args: Record<string, unknown> = {}) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const pending = $.tool.call({ tool: TOOL, prompt: 'Explore le depot', budgetMs: 600_000, ...args })
  await clock.advance(2_000) // un tour de suivi : la session est retrouvee
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  return { pending, ui }
}

test("l'arret rend la main avec un compte rendu qui dit qu'il vient de l'utilisateur", { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { argvs } = stub(on, clock, new Map(), { runMs: 300_000 })

  const { pending, ui } = await started($, clock)
  expect(await ui.find({ key: 'stop-1' })).toBeDefined()
  await ui.press({ key: 'stop-1' })
  const out: any = await pending
  await ui.unmount()

  // la session a bien ete interrompue cote serveur
  expect(argvs.some((argv) => argv[2] === 'session.interrupt')).toBe(true)
  // et Claude apprend que ca vient de l'utilisateur, pas d'un echec
  expect(out.result).toContain("L'utilisateur a arrete la delegation")
  expect(out.result).toContain(SERVER_SID)
})

test('le resultat tardif du processus est ignore', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted } = stub(on, clock, new Map(), { runMs: 300_000 })

  // en arriere-plan, pour que la notification soit observable
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Explore le depot', background: true, budgetMs: 600_000 })
  await clock.advance(2_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop-1' })
  await clock.advance(2_000) // la fenetre de regroupement se ferme
  const afterStop = submitted.length
  expect(afterStop).toBe(1)
  expect(submitted[0]).toContain("L'utilisateur a arrete la delegation")

  // le processus rend sa sortie bien plus tard : rien ne doit bouger
  await clock.advance(400_000)
  expect(submitted.length).toBe(afterStop)
  // la carte reste arretee, elle ne repasse pas en terminee
  expect(await ui.find({ type: 'Text', text: /arrete/ })).toBeDefined()
  await ui.unmount()
})

test("sans session retrouvee, aucun bouton d'arret", { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map(), { runMs: 300_000, noSession: true })

  const { ui } = await started($, clock)
  // la carte existe, mais rien a interrompre : pas de bouton mort
  expect(await ui.find({ key: 'task-1' })).toBeDefined()
  expect(await ui.find({ key: 'stop-1' })).toBeUndefined()
  await ui.unmount()
})
