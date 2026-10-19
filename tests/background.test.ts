import { expect, mock, test } from 'claude-code/testing'

// La delegation de fond : l'outil rend la main tout de suite, le travail tourne
// dans un rappel de minuteur, et le compte rendu revient par `$.prompt.submit`,
// dans un tour a lui. Trois choses se verifient ici en plus du cas nominal : un
// echec revient comme tel, deux fins simultanees ne font qu'une notification, et
// un rechargement du module ne laisse pas une carte mentir.

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
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({
            data: [{ id: SERVER_SID, time: { created: Date.now() }, location: { directory: '/work' } }],
          }),
          stderr: '',
        },
      }
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

// Le temps qu'il faut pour que la tache finisse, puis que la fenetre de
// regroupement se ferme et que la notification partie
async function settleBackground(clock: any, extraMs = 0) {
  await clock.advance(2_000) // un tour de suivi
  await clock.advance(5_000 + extraMs) // la tache rend la main
  await clock.advance(5_000) // la fenetre de regroupement, puis le prompt
  await clock.settle()
}

test('background: true rend la main avant meme que la tache ne demarre', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { run, submitted } = stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })

  // rendu tout de suite : `opencode run` n'a pas encore ete lance
  expect(run()).toEqual([])
  expect(submitted).toEqual([])
  // et le resultat dit assez clairement de ne pas attendre ni rappeler l'outil
  expect(out.result).toContain('arriere-plan')
  expect(out.result).toContain('NE PAS rappeler cet outil')
  expect(out.result).toContain('tour suivant')

  await settleBackground(clock)
})

test('le compte rendu complet arrive plus tard, dans un tour a lui', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted, run } = stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })
  await settleBackground(clock)

  expect(run().length).toBe(1)
  expect(submitted.length).toBe(1)
  const report = submitted[0]
  // le meme compte rendu que rendrait le mode bloquant : reponse, session,
  // repertoire, commit
  expect(report).toContain('a.txt dit bonjour')
  expect(report).toContain('session opencode: ' + SERVER_SID)
  expect(report).toContain('ou: /work @ abc123def456 (main) checkout propre')
  // et de quoi comprendre que c'est un resultat differe, pas une demande
  expect(report).toContain("resultat differe")
  expect(report).toContain('rien a relancer')
})

test('la carte de fond vit comme une autre, du debut a la fin', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })
  await clock.advance(2_000) // la tache tourne : le suivi a deja parle

  const during = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await during.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
  expect(await during.find({ key: 'task-1' })).toBeDefined()
  expect(await during.find({ type: 'Text', text: 'Lecture de a.txt' })).toBeDefined()
  // la carte dit que son resultat arrivera ailleurs
  expect(await during.find({ type: 'Text', text: /fond/ })).toBeDefined()
  const running: any = await during.find({ key: 'fold-running' })
  expect(running.props.label).toContain('En cours 1')
  await during.unmount()

  await settleBackground(clock)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const after = await $.ui.mount({ ...PANE, surface })
    expect(await after.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
    const done: any = await after.find({ key: 'fold-done' })
    expect(done.props.label).toContain('Terminees 1')
    expect(await after.find({ key: 'fold-running' })).toBeUndefined()
    await after.unmount()
  }
})

test('un echec de fond est notifie comme un echec, avec sa cause', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted } = stub(on, clock, new Map(), { run: 'provider' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })
  await settleBackground(clock)

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('cote fournisseur de modele')
  expect(submitted[0]).toContain('This API key has expired.')
  // et comment reprendre, comme en mode bloquant
  expect(submitted[0]).toContain('resume: "')
})

test("une commande qui ne demarre pas est notifiee aussi", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted } = stub(on, clock, new Map(), { run: 'start' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })
  await settleBackground(clock)

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain("n'a pas pu demarrer")
})

test('deux fins presque simultanees ne font quand meme qu une notification', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted } = stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })
  await $.tool.call({ tool: TOOL, prompt: 'Lis b.txt', background: true })
  await settleBackground(clock)

  // chaque `$.prompt.submit` attend que la session soit inactive : deux appels
  // feraient deux tours de suite, le second coupant ce que l'utilisateur vient
  // de commencer. Un seul tour, deux comptes rendus.
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('2 delegations opencode')
  expect(submitted[0]).toContain('=== delegation 1/2 ===')
  expect(submitted[0]).toContain('=== delegation 2/2 ===')
})

test("l'ecriture est lue a l'appel, jamais au lancement du job", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { argvs, run, submitted } = stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // l'interrupteur est desarme a l'appel : rien ne part, et le resultat est
  // immediat comme un refus l'est toujours
  const out: any = await $.tool.call({
    tool: TOOL,
    prompt: 'Renomme la fonction',
    writeFiles: true,
    background: true,
  })
  expect(out.result).toContain("L'ecriture n'est pas armee")

  // l'utilisateur arme apres coup : ca ne doit rien debloquer
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'write-toggle' })
  await ui.unmount()
  await settleBackground(clock)

  expect(run()).toEqual([])
  expect(argvs.some((argv) => argv.includes('--auto'))).toBe(false)
  expect(submitted).toEqual([])
})

test("une tache de fond partie en lecture seule reste en lecture seule", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', agent: 'build', background: true })

  // l'interrupteur s'arme pendant que le job attend son tour de minuteur
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'write-toggle' })
  await ui.unmount()
  await settleBackground(clock)

  const argv = run()[0].join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('--auto')
  expect(argv).not.toContain('build')
})

test('un rechargement ne laisse pas la carte mentir, et la perte est notifiee', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  // ce que le module d'avant le rechargement avait laisse dans le store
  const saved = new Map<string, unknown>([
    [
      'bg:' + SESSION,
      {
        updatedAt: Date.now() - 30_000,
        jobs: [
          {
            key: 'job-1',
            startedAt: Date.now() - 40_000,
            lastSeenAt: Date.now() - 30_000,
            prompt: 'Lis tout le module auth',
            model: 'p/m',
            mayWrite: false,
            timeoutMs: 300_000,
            sessionId: SERVER_SID,
            checkout: { dir: '/work', commit: 'abc123def456', branch: 'main', isDirty: false, behind: 0 },
          },
        ],
      },
    ],
  ])
  const { submitted } = stub(on, clock, saved)

  // le rechargement : `session.start` repasse dans un module neuf, sans ses
  // minuteurs ni ses taches
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(5_000)
  await clock.settle()

  // la perte est dite, avec ce qu'opencode avait garde et comment reprendre
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('recharge')
  expect(submitted[0]).toContain('Lis tout le module auth')
  expect(submitted[0]).toContain("ce que j'avais lu")
  expect(submitted[0]).toContain('resume: "' + SERVER_SID + '"')
  // le marqueur est consomme : un second demarrage ne redira pas la meme chose
  expect(saved.has('bg:' + SESSION)).toBe(false)

  // et la carte dit « rechargement », pas « en cours »
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /rechargement/ })).toBeDefined()
  expect(await ui.find({ key: 'fold-running' })).toBeUndefined()
  await ui.unmount()
})

test('un job de fond perdu depuis longtemps ne reveille plus la session', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const stale = Date.now() - 60 * 60 * 1_000
  const saved = new Map<string, unknown>([
    [
      'bg:' + SESSION,
      {
        updatedAt: stale,
        jobs: [
          {
            key: 'job-1',
            startedAt: stale,
            lastSeenAt: stale,
            prompt: 'Lis tout le module auth',
            model: 'p/m',
            timeoutMs: 300_000,
            sessionId: SERVER_SID,
          },
        ],
      },
    ],
  ])
  const { submitted, logs } = stub(on, clock, saved)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(5_000)
  await clock.settle()

  // son budget est passe depuis une heure : la tache a pu finir toute seule, et
  // ouvrir un tour pour en parler reveillerait la session pour rien
  expect(submitted).toEqual([])
  expect(logs.some((line) => line.includes('perdue par un rechargement'))).toBe(true)
  // la carte est la quand meme, pour que le pane ne mente pas
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /rechargement/ })).toBeDefined()
  await ui.unmount()
})

test('les marqueurs des autres sessions sont laisses tranquilles', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const saved = new Map<string, unknown>([
    ['bg:une-autre-session', { updatedAt: Date.now(), jobs: [{ key: 'job-9', startedAt: Date.now() }] }],
    ['defaultModel', 'p/m'],
  ])
  const { submitted } = stub(on, clock, saved)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(5_000)
  await clock.settle()

  // un job d'une autre session n'est pas le notre : ni carte, ni notification
  expect(submitted).toEqual([])
  expect(saved.has('bg:une-autre-session')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Aucune tache pour le moment.' })).toBeDefined()
  await ui.unmount()
})

test('le mode bloquant reste le defaut et ne notifie rien', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted } = stub(on, clock, new Map())

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const pending = $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })
  await clock.advance(2_000)
  await clock.advance(5_000)
  const out: any = await pending

  // le resultat arrive par l'appel, comme avant, et rien n'entre par un prompt
  expect(out.result).toContain('a.txt dit bonjour')
  await clock.advance(5_000)
  expect(submitted).toEqual([])
})

test("le marqueur d'un job de fond est ecrit puis efface", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const saved = new Map<string, unknown>()
  stub(on, clock, saved)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt', background: true })

  // des l'appel, avant que le job ne tourne : c'est tout l'interet du marqueur
  const held: any = saved.get('bg:' + SESSION)
  expect(held.jobs.length).toBe(1)
  expect(held.jobs[0].prompt).toBe('Lis a.txt')

  await settleBackground(clock)
  // la tache a conclu : plus rien a reprendre au prochain demarrage
  expect(saved.has('bg:' + SESSION)).toBe(false)
})
