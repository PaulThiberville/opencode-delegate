import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__opencode-delegate__delegate'

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

// `version` porte ce que `opencode --version` repond ; `absent` fait rejeter
// l'appel, comme `$.process.run` le fait quand le binaire ne demarre pas
function stubPreflight(on: any, { version, absent }: { version?: string; absent?: boolean }) {
  const registered: string[] = []
  const logs: string[] = []
  on('tool.register', ($: any, e: any) => {
    registered.push(e.name)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('process.run', ($: any, e: any) => {
    if (e.argv[1] !== '--version') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (absent) return { deny: "spawn opencode ENOENT" }
    return { value: { exitCode: 0, stdout: version, stderr: '' } }
  })
  // la question d'autorisation ne devrait jamais partir ici
  on('tool.call', () => ({ result: 'le moteur a repondu' }))
  return { registered, logs }
}

test("opencode absent : l'outil n'est pas enregistre et le pane le dit", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { registered, logs } = stubPreflight(on, { absent: true })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  // rien a proposer a Claude : un outil qui ne peut qu'echouer coute un tour
  expect(registered).toEqual([])
  // dit une fois ce qui manque et quoi faire
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('introuvable')
  expect(logs[0]).toContain('opencode 2.x')

  // le pane explique, au lieu d'un selecteur et d'une liste vide trompeuse
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Delegation indisponible' })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'model' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Aucune tache pour le moment.' })).toBeUndefined()
    await ui.unmount()
  }
})

test("opencode en 1.x : l'outil n'est pas enregistre et le pane nomme la version", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { registered, logs } = stubPreflight(on, { version: 'opencode v1.4.2' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(registered).toEqual([])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('1.4.2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\.4\.2/ })).toBeDefined()
  expect(await ui.find({ type: 'Select', key: 'model' })).toBeUndefined()
  await ui.unmount()
})

test("sans opencode, le contexte du premier message n'annonce pas la capacite", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stubPreflight(on, { absent: true })
  on('prompt.context', ($: any, e: any) => ({ blocks: e.blocks }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  const context: any = await $.prompt.context({ blocks: [] })
  expect(context.blocks).toEqual([])
})

test("la commande /opencode reste enregistree sans opencode", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const commands: string[] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', ($: any, e: any) => {
    commands.push(e.name)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ deny: 'spawn opencode ENOENT' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(commands).toEqual(['opencode'])
  // elle ouvre le pane, qui porte l'explication
  expect(await $.command.run({ command: 'opencode', args: '' })).toEqual({})
})

test("opencode en 2.x : l'outil est enregistre", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { registered, logs } = stubPreflight(on, { version: 'opencode v2.0.32' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(registered).toEqual(['delegate'])
  expect(logs).toEqual([])
})
