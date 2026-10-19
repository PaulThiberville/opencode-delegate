import { expect, mock, test } from 'claude-code/testing'

// Voir ses propres delegations. Deux capacites, un seul outil qui porte une
// action : `list` rend les delegations de la session, `log` rend le journal de
// l'une d'elles. Ce que ces tests doivent montrer, au-dela du cas nominal :
// qu'une tache deja en vol se reconnait avant d'etre relancee, qu'on peut
// decider d'attendre un compte rendu de fond plutot que de le repayer, et que
// le journal d'une session bavarde ne noie pas le contexte de Claude.

const TOOL = 'mcp__opencode-delegate__delegate'
const LOOK = 'mcp__opencode-delegate__delegations'
const SESSION = 'sess-claude-1'
const SERVER_SID = 'ses_eac681071ffewObMBj6e5N7Ykt'

const RUN_STDOUT = [
  '{"type":"tool_use","timestamp":2,"sessionID":"SID","part":{"id":"p1","type":"tool","tool":"read","state":{"status":"completed","title":"read a.txt","time":{"start":1000,"end":1420}}}}',
  '{"type":"text","timestamp":4,"sessionID":"SID","part":{"id":"p3","type":"text","text":"a.txt dit bonjour"}}',
].join('\n')

const SESSION_GET = JSON.stringify({
  data: { id: SERVER_SID, cost: 0.0004, tokens: { input: 10, output: 5 }, title: 'Lecture de a.txt' },
})

// Un journal court : deux outils et deux prises de parole, dans l'ordre
const MESSAGES = [
  {
    id: 'm1',
    time: { created: 1 },
    type: 'assistant',
    content: [
      { type: 'tool', name: 'read', state: { status: 'completed', title: 'read taxonomy.ts', time: { start: 1000, end: 1420 } } },
      { type: 'text', text: 'piste abandonnee : la taxonomie ne porte pas les cles' },
      { type: 'tool', name: 'grep', state: { status: 'error', title: 'grep i18n', time: { start: 1500, end: 4500 } } },
      { type: 'text', text: 'conclusion : les cles vivent dans Translations/resources' },
    ],
  },
]

// Une session bavarde : bien plus d'appels que la fenetre n'en montre
const MANY = [
  {
    id: 'm1',
    time: { created: 1 },
    type: 'assistant',
    content: Array.from({ length: 95 }, (_, i) => ({
      type: 'tool',
      name: 'read',
      state: { status: 'completed', title: 'read fichier-' + i + '.ts', time: { start: 1000, end: 1010 } },
    })),
  },
]

type Shape = { messages?: unknown[]; messagesFail?: boolean }

function stub(on: any, clock: any, saved: Map<string, unknown>, shape: Shape = {}) {
  const submitted: string[] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: SESSION }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
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
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', async ($: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    if (argv[0] === 'git') {
      if (argv[1] === 'rev-parse') return { value: { exitCode: 0, stdout: 'abc123def456789\nmain\n', stderr: '' } }
      if (argv[1] === 'status') return { value: { exitCode: 0, stdout: '', stderr: '' } }
      return { value: { exitCode: 1, stdout: '', stderr: '' } }
    }
    if (argv[2] === 'session.message.list') {
      if (shape.messagesFail) return { value: { exitCode: 1, stdout: '', stderr: 'no such session' } }
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: shape.messages ?? MESSAGES }), stderr: '' } }
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
    await clock.sleep(5_000)
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })
  return { submitted }
}

test('sans delegation, la liste dit qu\'il n\'y a rien en vol', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map())
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: LOOK, action: 'list' })
  expect(out.result).toContain('Aucune delegation')
  expect(out.result).toContain("rien n'est en vol")
})

test('une delegation en vol se reconnait, et la liste dit de ne pas la relancer', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map())
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  // la delegation part et tourne encore : c'est exactement le moment ou Claude
  // risque de relancer la meme tache une seconde fois
  const flying = $.tool.call({ tool: TOOL, prompt: 'parite des cles i18n', budgetMs: 600_000 })
  await clock.advance(2_000)

  const out: any = await $.tool.call({ tool: LOOK, action: 'list' })
  expect(out.result).toContain('en cours')
  expect(out.result).toContain('1 tourne encore')
  // la phrase qui doit arreter la main de Claude
  expect(out.result).toContain('ne pas relancer la meme tache')
  expect(out.result).toContain('payee')
  // de quoi la reprendre ou la relire plutot que la refaire
  expect(out.result).toContain(SERVER_SID)
  expect(out.result).toContain('parite des cles i18n')

  await clock.advance(10_000)
  await flying
})

test('la liste dit si le compte rendu de fond est deja remis ou pas encore', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { submitted } = stub(on, clock, new Map())
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: TOOL, prompt: 'resume des hooks', background: true })

  // en vol : le compte rendu arrivera tout seul, il n'y a qu'a attendre
  await clock.advance(2_000)
  let out: any = await $.tool.call({ tool: LOOK, action: 'list' })
  expect(out.result).toContain('fond :')
  expect(out.result).toContain('rien a attendre ni a relancer')

  // la tache a fini, mais la fenetre de regroupement n'a pas encore livre :
  // c'est la fenetre ou Claude doit attendre, pas relancer. Elle dure GROUP_MS,
  // donc on y entre par petits pas plutot qu'en pariant sur l'instant exact.
  let waited = null as string | null
  for (let step = 0; step < 20 && !waited; step++) {
    await clock.advance(500)
    if (submitted.length) break
    const look: any = await $.tool.call({ tool: LOOK, action: 'list' })
    if (look.result.includes('pas encore remis')) waited = look.result
  }
  expect(submitted).toHaveLength(0)
  expect(waited).not.toBeNull()
  expect(waited).toContain('pas encore remis')
  expect(waited).toContain('a fini')

  // remis : plus rien a attendre
  await clock.advance(5_000)
  await clock.settle()
  expect(submitted).toHaveLength(1)
  out = await $.tool.call({ tool: LOOK, action: 'list' })
  expect(out.result).toContain('deja remis')
  expect(out.result).not.toContain('pas encore remis')
})

test('le journal rend les outils dans l\'ordre et ce qui a ete dit', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map())
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: LOOK, action: 'log', sessionId: SERVER_SID })
  // les deux appels, dans l'ordre ou ils ont eu lieu, avec leur duree
  expect(out.result).toContain('read taxonomy.ts')
  expect(out.result).toContain('420ms')
  expect(out.result).toContain('grep i18n')
  // un outil qui n'a pas abouti le dit
  expect(out.result).toContain('(error)')
  expect(out.result.indexOf('read taxonomy.ts')).toBeLessThan(out.result.indexOf('grep i18n'))
  // la piste abandonnee, que le texte final seul ne donnait pas
  expect(out.result).toContain('piste abandonnee')
  expect(out.result).toContain('conclusion : les cles vivent')
  // rien n'a ete relance
  expect(out.result).toContain('sans rien relancer')
})

test('un journal trop long est borne, le dit, et donne de quoi demander la suite', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map(), { messages: MANY })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: LOOK, action: 'log', sessionId: SERVER_SID })
  expect(out.result).toContain('95 appels')
  expect(out.result).toContain('affiches 1-40')
  expect(out.result).toContain('tronque')
  // de quoi lire la suite sans relancer la tache
  expect(out.result).toContain('`offset: 40`')
  expect(out.result).toContain('read fichier-0.ts')
  expect(out.result).toContain('read fichier-39.ts')
  expect(out.result).not.toContain('read fichier-40.ts')

  // la suite demandee par offset
  const next: any = await $.tool.call({ tool: LOOK, action: 'log', sessionId: SERVER_SID, offset: 40 })
  expect(next.result).toContain('affiches 41-80')
  expect(next.result).toContain('read fichier-40.ts')
  expect(next.result).not.toContain('read fichier-39.ts')
})

test('toolsOnly laisse les textes de cote', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map())
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: LOOK, action: 'log', sessionId: SERVER_SID, toolsOnly: true })
  expect(out.result).toContain('read taxonomy.ts')
  expect(out.result).not.toContain('piste abandonnee')
})

test('un journal illisible ne pretend pas en etre un', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, clock, new Map(), { messagesFail: true })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: LOOK, action: 'log', sessionId: 'ses_inconnue' })
  expect(out.result).toContain("n'a pas pu etre relu")
  expect(out.result).toContain("Rien n'a ete relance")

  // et un `log` sans id dit lequel il attend
  const bare: any = await $.tool.call({ tool: LOOK, action: 'log' })
  expect(bare.result).toContain('demande un `sessionId`')
})
