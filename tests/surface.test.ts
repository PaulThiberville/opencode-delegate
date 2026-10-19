import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'opencode-delegate',
  component: 'Pane',
  requestId: 'opencode-delegate',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'opencode', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

// Le vrai `opencode models` rend environ 500 lignes, bien au-dela des 64
// options qu'un Select accepte : au-dela, le moteur refuse l'arbre entier
const BIG_CATALOG = Array.from({ length: 501 }, (_, i) => 'provider' + (i % 7) + '/model-' + i).join('\n')

function stub(on: any, catalog: string) {
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: catalog, stderr: '' } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['dessine par le moteur'] }))
}

test('le pane se dessine sur chaque surface malgre un gros catalogue', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, BIG_CATALOG)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle() // le catalogue arrive

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // notre arbre passe : le selecteur est la et le moteur n'a pas pris la main
    expect(await ui.find({ type: 'Select', key: 'model' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'dessine par le moteur' })).toBeUndefined()
    await ui.unmount()
  }
})

test('le champ de saisie annonce le reste du catalogue', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  stub(on, BIG_CATALOG)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const field: any = await ui.find({ key: 'model-input' })
  expect(field.props.placeholder).toContain('501 au catalogue')
  await ui.unmount()
})
