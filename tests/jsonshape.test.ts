import { expect, mock, test } from 'claude-code/testing'

// La sortie en JSON. Ce qui est teste ici n'est pas un schema impose — opencode
// 2.0.32 n'a aucun champ de schema, la mesure est dans le README — mais la
// verification que le mod fait a la place : il demande la forme dans le prompt,
// relit la reponse, et dit laquelle des deux il tient en main. Le cas qui
// compte le plus est celui ou le modele ne suit pas : le mod doit le dire et
// rendre le texte brut, sans jamais inventer un champ.

const TOOL = 'mcp__opencode-delegate__delegate'
const SHAPE = {
  type: 'object',
  properties: { fichiers: { type: 'array' }, risques: { type: 'array' }, total: { type: 'integer' } },
  required: ['fichiers', 'risques'],
}

function textEvent(text: string) {
  return JSON.stringify({
    type: 'text',
    timestamp: 4,
    sessionID: 'SID',
    part: { id: 'p1', type: 'text', text },
  })
}

function stub(on: any, answer: string) {
  const argvs: string[][] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', async ($: any, e: any) => {
    const argv: string[] = e.argv
    argvs.push(argv)
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    if (argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'pas un depot' } }
    if (argv[1] === 'api') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { id: 'ses_x' } }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: textEvent(answer), stderr: '' } }
  })
  return { argvs, run: () => argvs.find((argv) => argv[1] === 'run') as string[] }
}

test('la contrainte de forme part dans le prompt, pas dans la carte', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on, '{"fichiers":["a.ts"],"risques":[]}')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: TOOL, prompt: 'inventaire des .ts', schema: SHAPE })

  const sent = run()[run().length - 1]
  // la tache demandee reste en tete, notre boilerplate vient apres
  expect(sent.startsWith('inventaire des .ts')).toBe(true)
  expect(sent).toContain('CONTRAINTE DE SORTIE')
  // le schema lui-meme est dans le prompt, c'est tout ce qu'on peut faire
  expect(sent).toContain('"fichiers"')
  expect(sent).toContain('required')
})

test('une reponse conforme est rendue comme des donnees', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  stub(on, '{"fichiers":["a.ts","b.ts"],"risques":["division par zero"],"total":2}')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: SHAPE })
  expect(out.result).toContain('conforme au schema')
  expect(out.result).toContain('"division par zero"')
  // et le mod dit jusqu'ou va sa verification, sans la surjouer
  expect(out.result).toContain('premier niveau')
})

test('du JSON noye dans une phrase ou un bloc de code est quand meme lu', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  stub(on, 'Voici le resultat :\n```json\n{"fichiers":["a.ts"],"risques":[]}\n```\nVoila.')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: SHAPE })
  expect(out.result).toContain('conforme au schema')
  expect(out.result).toContain('"a.ts"')
})

test('du texte au lieu du JSON : le mod le dit et rend la reponse brute', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  stub(on, "Il y a deux fichiers, a.ts et b.ts, et je n'ai pas vu de risque notable.")
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: SHAPE })
  expect(out.result).toContain("N'EST PAS VENUE")
  // la raison, pour que Claude ne croie pas a un bug du mod
  expect(out.result).toContain("n'a aucun champ de schema")
  // le travail paye n'est pas jete
  expect(out.result).toContain('a.ts et b.ts')
  // et surtout : aucun champ invente
  expect(out.result).not.toContain('"fichiers"')
})

test('du JSON hors schema est signale sans etre corrige', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  // `risques` manque, et `total` est une chaine la ou un entier est declare
  stub(on, '{"fichiers":["a.ts"],"total":"deux"}')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: SHAPE })
  expect(out.result).toContain('HORS SCHEMA')
  expect(out.result).toContain('la cle requise `risques` manque')
  expect(out.result).toContain('`total` est un string au lieu d\'un integer')
  // rendu tel quel : le mod ne fabrique pas le `risques` absent
  expect(out.result).toContain('sans aucun champ ajoute')
  expect(out.result).toContain('"total": "deux"')
})

test('un schema mal forme ne part pas en silence', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { argvs } = stub(on, '{}')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: 'un objet avec des fichiers' })
  expect(out.result).toContain('doit etre un objet JSON Schema')
  expect(out.result).toContain("Rien ne s'est execute")
  // et rien n'a effectivement tourne
  expect(argvs.some((argv) => argv[1] === 'run')).toBe(false)
})

test('sans schema, la reponse reste du texte libre', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on, 'deux fichiers, aucun risque')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire' })
  expect(out.result).toContain('deux fichiers, aucun risque')
  expect(out.result).not.toContain('CONTRAINTE DE SORTIE')
  expect(run()[run().length - 1]).not.toContain('CONTRAINTE DE SORTIE')
})

test('une tache qui ne conclut rien ne passe pas pour du texte hors schema', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  stub(on, '')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: SHAPE })
  expect(out.result).toContain("n'a rien conclu du tout")
  expect(out.result).toContain('`action: "log"`')
  // et surtout pas le message « opencode a repondu du texte »
  expect(out.result).not.toContain('a repondu du texte')
})

test('la carte dit si le json demande est venu', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  stub(on, 'du texte, pas du json')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.tool.call({ tool: TOOL, prompt: 'inventaire', schema: SHAPE })

  const ui = await $.ui.mount({
    plugin: 'opencode-delegate',
    component: 'Pane',
    requestId: 'opencode-delegate',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { title: 'opencode', isFocused: true, bodyColumns: 48, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /json manque/ })).toBeDefined()
  // le moteur n'a pas pris la main
  expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
  await ui.unmount()
})
