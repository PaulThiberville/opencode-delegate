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

const APP_BIN = '/Applications/OpenCode.app/Contents/Resources/opencode-cli'

// Ce que chaque binaire repond a `--version` ; un binaire sans entree ne demarre
// pas. Retient tous les argv, pour voir lequel le mod lance ensuite.
function stubBinaries(on: any, versions: Record<string, string>) {
  const registered: string[] = []
  const logs: string[] = []
  const argvs: string[][] = []
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
    argvs.push(e.argv)
    if (!(e.argv[0] in versions)) return { deny: 'spawn ' + e.argv[0] + ' ENOENT' }
    const stdout = e.argv[1] === '--version' ? versions[e.argv[0]] : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { registered, logs, argvs }
}

test("seule l'app Desktop est installee : le mod lance son CLI", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { registered, logs, argvs } = stubBinaries(on, { [APP_BIN]: 'opencode v2.2.6' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(registered).toEqual(['delegate', 'delegations'])
  expect(logs).toEqual([])
  // le catalogue des modeles part du binaire retenu, pas d'un `opencode` absent
  const models = argvs.find((argv) => argv[1] === 'models')
  expect(models?.[0]).toBe(APP_BIN)
})

test("une 1.x dans le PATH n'empeche pas d'utiliser l'app en 2.x", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { registered, logs, argvs } = stubBinaries(on, {
    opencode: 'opencode v1.14.46',
    [APP_BIN]: 'opencode v2.2.6',
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(registered).toEqual(['delegate', 'delegations'])
  expect(logs).toEqual([])
  expect(argvs.find((argv) => argv[1] === 'models')?.[0]).toBe(APP_BIN)
})

test("une 2.x dans le PATH passe avant l'app, qui n'est meme pas sondee", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { argvs } = stubBinaries(on, {
    opencode: 'opencode v2.0.32',
    [APP_BIN]: 'opencode v2.2.6',
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(argvs.map((argv) => argv[0])).not.toContain(APP_BIN)
  expect(argvs.find((argv) => argv[1] === 'models')?.[0]).toBe('opencode')
})

test("aucun binaire en 2.x : la 1.x presente l'emporte sur l'absent dans le message", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  // l'app seule, encore en 1.x : le PATH est vide, mais « introuvable » serait faux
  const { registered, logs } = stubBinaries(on, { [APP_BIN]: 'opencode v1.14.20' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  expect(registered).toEqual([])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('1.14.20')
  expect(logs[0]).not.toContain('introuvable')
})

test("opencode en 2.x : les deux outils sont enregistres", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { registered, logs } = stubPreflight(on, { version: 'opencode v2.0.32' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  // `delegate` delegue, `delegations` regarde ce qui a ete delegue
  expect(registered).toEqual(['delegate', 'delegations'])
  expect(logs).toEqual([])
})
