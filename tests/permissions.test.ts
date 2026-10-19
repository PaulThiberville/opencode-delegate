import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__opencode-delegate__delegate'

const RUN_STDOUT =
  '{"type":"text","timestamp":4,"sessionID":"SID","part":{"id":"p3","type":"text","text":"fini"}}'

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

function stub(on: any) {
  const argvs: string[][] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    argvs.push(argv)
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    // le sondage du checkout : hors depot git ici, donc tout sort en erreur
    if (argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'not a git repo' } }
    if (argv[1] === 'api') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { id: 'ses_x' } }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })
  return { argvs, run: () => argvs.find((argv) => argv[1] === 'run') }
}

// Arme l'ecriture comme l'utilisateur le fait : en basculant l'interrupteur
// du pane, et pas autrement
async function arm($: any) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'write-toggle' })
  const toggle: any = await ui.find({ key: 'write-toggle' })
  await ui.unmount()
  return toggle.props.label
}

test('par defaut la tache part en lecture seule, sans --auto et en agent plan', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })

  const argv = run()!.join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('--auto')
  expect(out.result).toContain('mode: lecture seule')
})

test("un agent libre ne rouvre pas l'ecriture en lecture seule", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Claude demande l'agent `build`, qui ecrit, sans que l'ecriture soit armee
  await $.tool.call({ tool: TOOL, prompt: 'Refactor', agent: 'build' })

  const argv = run()!.join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('build')
  expect(argv).not.toContain('--auto')
})

test("interrupteur desarme : la delegation en ecriture ne part pas", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Renomme', writeFiles: true })

  // rien n'a tourne, et le resultat dit a Claude quoi faire
  expect(run()).toBeUndefined()
  expect(out.result).toContain("L'ecriture n'est pas armee")
  expect(out.result).toContain('/opencode')
})

test("interrupteur arme : la delegation en ecriture part avec son agent", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await arm($)).toContain('armee')

  const out: any = await $.tool.call({
    tool: TOOL,
    prompt: 'Renomme la fonction',
    writeFiles: true,
    agent: 'build',
  })

  const argv = run()!.join(' ')
  expect(argv).toContain('--auto')
  expect(argv).toContain('--agent build')
  expect(out.result).toContain('mode: ecriture')
})

test("l'interrupteur se desarme aussi bien qu'il s'arme", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await arm($)
  // seconde bascule : retour a l'etat desarme
  expect(await arm($)).toContain('desarmee')

  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Renomme', writeFiles: true })
  expect(run()).toBeUndefined()
  expect(out.result).toContain("L'ecriture n'est pas armee")
})

test("l'interrupteur arme ne transforme pas une lecture en ecriture", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await arm($)
  // sans `writeFiles`, la tache reste en lecture seule
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })

  const argv = run()!.join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('--auto')
})

test("le pane ne signale que l'ecriture, la lecture etant le defaut", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })
  await arm($)
  await $.tool.call({ tool: TOOL, prompt: 'Corrige a.txt', writeFiles: true })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
    // la carte en ecriture le dit ; celle en lecture seule n'alourdit pas la
    // ligne avec le cas nominal
    expect(await ui.find({ type: 'Text', text: /ecriture/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\blecture\b/ })).toBeUndefined()
    await ui.unmount()
  }
})
