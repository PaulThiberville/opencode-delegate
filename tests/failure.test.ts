import { expect, mock, test } from 'claude-code/testing'

// Ce que le mod rend quand la delegation s'arrete sans conclure : la cause, et
// ce qu'opencode avait deja produit. `$.process.run` ne rend rien du tout quand
// il tue le processus, donc tout vient de la session relue.

const TOOL = 'mcp__opencode-delegate__delegate'
const BUDGET = 300_000

const SERVER_SID = 'ses_eac681071ffewObMBj6e5N7Ykt'

// La forme reelle d'`opencode api session.message.list`, du plus recent au plus
// ancien. Elle n'est pas celle de `session.get` : un `idle` porte `outcome` et
// `error`, un `assistant` porte `content`, et une part d'outil s'appelle `name`
// (pas `tool` comme dans le flux NDJSON).
const MESSAGES = [
  { id: 'm4', time: { created: 4 }, type: 'idle', outcome: 'failed' },
  {
    id: 'm3',
    time: { created: 3 },
    type: 'assistant',
    content: [{ type: 'text', text: 'Le module auth lit la config au demarrage.' }],
  },
  {
    id: 'm2',
    time: { created: 2 },
    type: 'assistant',
    content: [
      { type: 'reasoning' },
      { type: 'tool', name: 'read', state: { status: 'completed' } },
      { type: 'tool', name: 'grep', state: { status: 'error' } },
    ],
  },
  { id: 'm1', time: { created: 1 }, text: 'Lis le module auth', type: 'user' },
]

type Shape = {
  // ce que fait `opencode run` : rejeter apres tout le budget, rejeter tout de
  // suite, ou rendre une sortie
  run: 'budget' | 'start' | { exitCode: number; stdout: string; stderr?: string }
  messages?: unknown[]
}

function stub(on: any, clock: any, shape: Shape) {
  const logs: string[] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', async ($: any, e: any) => {
    const argv: readonly string[] = e.argv
    if (argv[1] === '--version') {
      return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    }
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
      const data = shape.messages === undefined ? MESSAGES : shape.messages
      return { value: { exitCode: 0, stdout: JSON.stringify({ data }), stderr: '' } }
    }
    if (argv[2] === 'session.list') {
      const items = [{ id: SERVER_SID, time: { created: Date.now() }, location: { directory: '/work' } }]
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: items }), stderr: '' } }
    }
    if (argv[1] === 'api') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { id: SERVER_SID } }), stderr: '' } }
    }
    // `opencode run` lui-meme
    if (shape.run === 'start') return { deny: 'spawn opencode ENOENT' }
    if (shape.run === 'budget') {
      // le processus tient jusqu'au bout du budget, puis `$.process.run` le tue
      await clock.sleep(BUDGET)
      return { deny: 'timed out after ' + BUDGET + 'ms' }
    }
    return { value: { stderr: '', ...shape.run } }
  })
  return { logs }
}

async function runTask($: any, clock: any, args: Record<string, unknown> = {}) {
  const pending = $.tool.call({ tool: TOOL, prompt: 'Lis le module auth', ...args })
  await clock.advance(BUDGET + 2_000)
  return pending
}

test('budget epuise : la cause est nommee et la sortie partielle est rendue', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, { run: 'budget' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock, { budgetMs: BUDGET })

  // la cause, et quoi en faire : un budget epuise se relance plus large
  expect(out.result).toContain('budget de 5m00 est epuise')
  expect(out.result).toContain('budgetMs')
  // sept minutes de lecture ne sont plus perdues : le texte vient de la session
  expect(out.result).toContain('Le module auth lit la config au demarrage.')
  // et a defaut de conclusion, au moins le journal des outils appeles
  expect(out.result).toContain('read, grep (error)')
  // la session reste nommee, pour un `resume`
  expect(out.result).toContain(SERVER_SID)
})

test('sans texte dans la session, le resultat le dit au lieu de mentir', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, { run: 'budget', messages: [] })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock, { budgetMs: BUDGET })

  expect(out.result).toContain('budget de 5m00 est epuise')
  expect(out.result).toContain("ne garde aucun texte")
})

test("une commande qui ne demarre pas n'est pas un budget epuise", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, { run: 'start' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock, { budgetMs: BUDGET })

  // rien n'a tourne : relancer plus large ne servirait a rien
  expect(out.result).toContain("n'a pas pu demarrer")
  expect(out.result).toContain("Verifier l'installation")
  expect(out.result).not.toContain('budget de')
})

test("une erreur de fournisseur est distinguee d'une erreur de tache", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, {
    run: {
      exitCode: 1,
      stdout:
        '{"type":"error","timestamp":1,"sessionID":"SID","error":{"type":"provider.auth","message":"This API key has expired."}}',
    },
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock)

  expect(out.result).toContain('cote fournisseur de modele')
  // le conseil qui va avec : relancer tel quel redonnera la meme erreur
  expect(out.result).toContain("Relancer a l'identique")
  expect(out.result).toContain('This API key has expired.')
})

test("une erreur qui n'est pas du fournisseur ne lui est pas imputee", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, {
    run: {
      exitCode: 1,
      stdout:
        '{"type":"error","timestamp":1,"sessionID":"SID","error":{"type":"tool.failed","message":"le patch ne s\'applique pas"}}',
    },
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await runTask($, clock)

  expect(out.result).toContain("s'est arrete en erreur pendant la tache")
  expect(out.result).not.toContain('cote fournisseur')
  expect(out.result).toContain("le patch ne s'applique pas")
})

test('la carte du pane nomme la cause de l\'arret', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, { run: 'budget' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await runTask($, clock, { budgetMs: BUDGET })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'opencode-delegate',
      component: 'Pane',
      requestId: 'opencode-delegate',
      surface,
      viewport: { columns: 120, rows: 40 },
      props: {
        title: 'opencode',
        isFocused: true,
        bodyColumns: 48,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 12 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /budget/ })).toBeDefined()
    await ui.unmount()
  }
})

// Le cinquieme cas, le tour abandonne, se reconnait a `next.signal` : le kit de
// test n'a pas de quoi abattre ce signal, donc il n'est pas couvert ici. Son
// traitement est le seul a ne jamais conseiller de relancer, et le seul a
// recopier le texte retrouve dans le transcript par `$.ui.log` — le resultat de
// l'outil ne va plus nulle part une fois le tour abandonne.
