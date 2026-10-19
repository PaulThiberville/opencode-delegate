import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__opencode-delegate__delegate'

// Les libelles que le mod propose dans `$.ui.ask`, et que `$.ui.ask` rend tels
// quels : un libelle qui ne correspond pas vaut un refus
const ALLOW = "Autoriser l'ecriture"
const READ_ONLY = 'Lecture seule'
const CANCEL = 'Annuler'

const RUN_STDOUT =
  '{"type":"text","timestamp":4,"sessionID":"SID","part":{"id":"p3","type":"text","text":"fini"}}'

// `answer` est ce que l'utilisateur repond ; `dismissed` ecarte la question,
// comme un `claude -p` ou personne ne peut repondre
function stub(on: any, { answer, dismissed }: { answer?: string; dismissed?: boolean } = {}) {
  const argvs: string[][] = []
  const asked: string[] = []
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  // `$.ui.ask` arrive ici comme un appel a AskUserQuestion
  on('tool.call', ($: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    if (dismissed) return { deny: 'personne ne peut repondre' }
    return { result: { answers: { [question]: answer } } }
  })
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
  return { argvs, asked, run: () => argvs.find((argv) => argv[1] === 'run') }
}

test('par defaut la tache part en lecture seule, sans --auto et en agent plan', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { asked, run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })

  // rien a demander : la tache ne peut pas ecrire
  expect(asked).toEqual([])
  const argv = run()!.join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('--auto')
  expect(out.result).toContain('mode: lecture seule')
})

test("un agent libre ne rouvre pas l'ecriture en lecture seule", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { asked, run } = stub(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Claude demande l'agent `build`, qui ecrit, mais sans demander l'ecriture
  await $.tool.call({ tool: TOOL, prompt: 'Refactor', agent: 'build' })

  expect(asked).toEqual([])
  const argv = run()!.join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('build')
  expect(argv).not.toContain('--auto')
})

test("l'ecriture part seulement quand l'utilisateur l'autorise", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { asked, run } = stub(on, { answer: ALLOW })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({
    tool: TOOL,
    prompt: 'Renomme la fonction',
    writeFiles: true,
    agent: 'build',
  })

  // la question nomme la tache, pour que la reponse soit informee
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Renomme la fonction')
  const argv = run()!.join(' ')
  expect(argv).toContain('--auto')
  expect(argv).toContain('--agent build')
  expect(out.result).toContain("mode: ecriture autorisee par l'utilisateur")
})

test('un refus de l\'utilisateur ne lance rien du tout', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { asked, run } = stub(on, { answer: CANCEL })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Supprime le module', writeFiles: true })

  expect(asked.length).toBe(1)
  // pas de `opencode run` : ni ecriture, ni repli silencieux en lecture seule
  expect(run()).toBeUndefined()
  expect(out.result).toContain("n'a pas autorise l'ecriture")
})

test("la reponse « lecture seule » degrade la tache au lieu de l'annuler", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on, { answer: READ_ONLY })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Corrige le bug', writeFiles: true })

  const argv = run()!.join(' ')
  expect(argv).toContain('--agent plan')
  expect(argv).not.toContain('--auto')
  expect(out.result).toContain('mode: lecture seule')
})

test("sans personne pour repondre, l'ecriture ne part pas", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const { run } = stub(on, { dismissed: true })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.tool.call({ tool: TOOL, prompt: 'Ecris les tests', writeFiles: true })

  expect(run()).toBeUndefined()
  expect(out.result).toContain("personne n'a pu l'autoriser")
})

test('deux delegations en ecriture coup sur coup : la seconde est refusee en clair', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const asked: string[] = []
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
  // La premiere question reste en attente : le moteur ne tient qu'un
  // AskUserQuestion a la fois, et c'est ce qui faisait revenir la seconde en
  // refus sans que personne ait rien refuse.
  on('tool.call', async ($: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    await clock.sleep(60_000)
    return { result: { answers: { [question]: ALLOW } } }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    argvs.push(argv)
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    if (argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: '' } }
    if (argv[1] === 'api') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { id: 'ses_x' } }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const first = $.tool.call({ tool: TOOL, prompt: 'Corrige a.txt', writeFiles: true })
  await clock.advance(1_000) // la premiere question est posee et attend
  const second: any = await $.tool.call({ tool: TOOL, prompt: 'Corrige b.txt', writeFiles: true })

  // une seule question posee, et la seconde delegation dit quoi faire
  expect(asked.length).toBe(1)
  expect(second.result).toContain('Une seule delegation en ecriture a la fois')
  expect(argvs.some((argv) => argv.join(' ').includes('Corrige b.txt'))).toBe(false)

  await clock.advance(60_000)
  await first
  // la premiere, elle, est allee au bout
  expect(argvs.some((argv) => argv.join(' ').includes('Corrige a.txt'))).toBe(true)
})

test('une seconde delegation en lecture seule passe pendant une question', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const asked: string[] = []
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
  on('tool.call', async ($: any, e: any) => {
    const question = e.questions[0].question
    asked.push(question)
    await clock.sleep(60_000)
    return { result: { answers: { [question]: ALLOW } } }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    argvs.push(argv)
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    if (argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: '' } }
    if (argv[1] === 'api') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { id: 'ses_x' } }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const first = $.tool.call({ tool: TOOL, prompt: 'Corrige a.txt', writeFiles: true })
  await clock.advance(1_000)
  // le garde-fou ne porte que sur l'ecriture : une lecture ne demande rien
  const second: any = await $.tool.call({ tool: TOOL, prompt: 'Lis b.txt' })

  expect(asked.length).toBe(1)
  expect(second.result).toContain('fini')
  expect(argvs.some((argv) => argv.join(' ').includes('Lis b.txt'))).toBe(true)

  await clock.advance(60_000)
  await first
})

test("le pane ne signale que l'ecriture, la lecture etant le defaut", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, { answer: ALLOW })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: TOOL, prompt: 'Lis a.txt' })
  await $.tool.call({ tool: TOOL, prompt: 'Corrige a.txt', writeFiles: true })

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
    // la carte en ecriture le dit ; celle en lecture seule n'alourdit pas la
    // ligne avec le cas nominal
    expect(await ui.find({ type: 'Text', text: /ecriture/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\blecture\b/ })).toBeUndefined()
    await ui.unmount()
  }
})
