import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__opencode-delegate__delegate'
const RUN_STDOUT =
  '{"type":"text","timestamp":4,"sessionID":"SID","part":{"id":"p3","type":"text","text":"fini"}}'

test('deux delegations lancees ensemble avancent en parallele', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', async ($: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[1] === '--version') return { value: { exitCode: 0, stdout: 'opencode v2.0.32', stderr: '' } }
    if (argv[1] === 'models') return { value: { exitCode: 0, stdout: 'p/m', stderr: '' } }
    if (argv[0] === 'pwd') return { value: { exitCode: 0, stdout: '/work\n', stderr: '' } }
    if (argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'pas un depot' } }
    if (argv[1] === 'api') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { id: 'ses_x' } }), stderr: '' } }
    }
    // la lente met dix minutes, la rapide deux
    const slow = argv[argv.length - 1].includes('LENTE')
    await clock.sleep(slow ? 600_000 : 120_000)
    return { value: { exitCode: 0, stdout: RUN_STDOUT, stderr: '' } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const order: string[] = []
  const slow = $.tool.call({ tool: TOOL, prompt: 'LENTE', budgetMs: 600_000 }).then(() => order.push('lente'))
  const fast = $.tool.call({ tool: TOOL, prompt: 'RAPIDE', budgetMs: 600_000 }).then(() => order.push('rapide'))

  // a deux minutes, la rapide a fini alors que la lente tourne encore : le mod
  // ne serialise pas. Si ces deux delegations ont l'air de s'attendre dans une
  // vraie session, c'est le protocole, pas nous : deux appels d'outil emis dans
  // le meme message rendent leurs resultats ensemble.
  await clock.advance(120_000)
  expect(order).toEqual(['rapide'])

  await clock.advance(480_000)
  expect(order).toEqual(['rapide', 'lente'])
  await Promise.all([slow, fast])
})
