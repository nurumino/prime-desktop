import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { build } from 'esbuild'

const binary = process.argv[2]
assert(binary, 'Usage: node scripts/check-agent-runtime.mjs /absolute/path/to/prime-agent')
const root = await mkdtemp(join(tmpdir(), 'prime-runtime-'))
const agentDir = join(root, 'agent')
await mkdir(agentDir)
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir
process.env.PRIME_AGENT_SESSION_DIR = join(agentDir, 'sessions')
process.env.PRIME_AGENT_KERNEL_VENV = join(root, 'kernel-venv')
// This check uses a local text provider, not Python tools. Prevent kernel installation.
process.env.PRIME_AGENT_KERNEL_PYTHON = join(root, 'disabled-test-python')
const requests = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push(input.model)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const delta = { id: 'test', object: 'chat.completion.chunk', model: input.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Runtime test passed.' }, finish_reason: null }] }
  res.write(`data: ${JSON.stringify(delta)}\n\n`)
  res.end(`data: ${JSON.stringify({ ...delta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
// Windows daemons listen on named pipes, not socket files.
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\prime-runtime-${process.pid}-${Date.now()}`
  : join(root, 'daemon.sock')
let transport
let client
try {
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'desktop-test': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'test-only',
      models: ['chosen', 'other'].map(id => ({
        id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }))
    }
  } }))
  await build({
    entryPoints: [resolve('src/main/daemonTransport.ts')], outfile: join(root, 'transport.mjs'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external'
  })
  const { DaemonTransport } = await import(pathToFileURL(join(root, 'transport.mjs')).href)
  await build({
    entryPoints: [resolve('src/main/primeFiles.ts')], outfile: join(root, 'preferences.mjs'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external'
  })
  const preferences = await import(pathToFileURL(join(root, 'preferences.mjs')).href)
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'chosen', customSetting: true }))
  assert.equal((await preferences.getMcpCatalog(binary)).length, 68)
  await preferences.setModelRole('subagentDefaultModel', 'desktop-test/other')
  await preferences.setModelRole('providerBackupModel', '')
  const saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
  assert.equal(saved.customSetting, true)
  assert.equal(saved.defaultModel, 'chosen')
  assert.equal(saved.subagentDefaultModel, 'desktop-test/other')
  assert.equal(saved.providerBackupModel, undefined)
  await assert.rejects(preferences.setModelRole('defaultModel', 'desktop-test/other'))
  await assert.rejects(preferences.setModelRole('auxiliaryModel', 'invalid'))
  const runtimeRoot = dirname(dirname(dirname(realpathSync(binary))))
  const { DaemonClient } = await import(pathToFileURL(join(runtimeRoot, 'dist/modes/daemon/daemon-client.js')).href)
  client = new DaemonClient(socketPath)
  const settings = {
    model: 'desktop-test/chosen', thinkingLevel: 'off', rlmMaxDepth: 1, transport: 'sse',
    autonomous: { enabled: false, maxContinuations: 1, maxTurns: 2, maxTokens: 2000, maxSeconds: 60, gates: [], gateRetries: 0 }
  }
  const open = async () => {
    transport = new DaemonTransport({ binary, socketPath, cwd: root, settings })
    await transport.start()
    const state = await transport.send({ type: 'get_state' })
    assert.equal(state.model.provider, 'desktop-test')
    assert.equal(state.model.id, 'chosen')
  }
  await open()
  await client.connect()
  await client.waitForHello()
  assert(client.supportsServerCapability('abort_and_send_queued'))
  assert(transport.supports('abort_and_send_queued'))
  const complete = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('No agent_end event')), 60000)
    transport.on('event', event => {
      if (event.type === 'agent_end') { clearTimeout(deadline); resolve() }
    })
  })
  await transport.send({ type: 'prompt', message: 'Reply with the test phrase.' })
  await complete
  assert.deepEqual(requests, ['chosen'])
  // Stop suspends input even with an empty queue. The next submitted prompt
  // must resume the same session, without reconnecting or clearing messages.
  await transport.send({ type: 'abort' })
  const resumed = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('No agent_end after Stop')), 60000)
    const onEvent = event => {
      if (event.type === 'agent_end') {
        clearTimeout(deadline)
        transport.off('event', onEvent)
        resolve()
      }
    }
    transport.on('event', onEvent)
  })
  await transport.send({ type: 'prompt', message: 'Reply again after Stop.' })
  await resumed
  assert.deepEqual(requests, ['chosen', 'chosen'])
  assert.match(await transport.withConnection(c => c.getLastAssistantText()), /Runtime test passed/)
  const state = await transport.send({ type: 'get_state' })
  assert(state.sessionFile, 'Session was not saved')
  await transport.send({ type: 'set_model', provider: 'desktop-test', modelId: 'other' })
  await transport.stop()
  await open()
  await transport.withConnection(c => c.switchSession(state.sessionFile))
  assert.match(await transport.withConnection(c => c.getLastAssistantText()), /Runtime test passed/)
} finally {
  await transport?.stop()
  if (client) {
    await client.connect().catch(() => {})
    await client.waitForHello()
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test daemon did not stop')), 20000)
      client.onClose(() => { clearTimeout(timer); resolve() })
    })
    const response = await client.request({ type: 'shutdown', force: true }, 10000)
    assert.equal(response.success, true, JSON.stringify(response))
    await closed
    client.close()
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
console.log('PASS: daemon startup, model selection, local prompt, Stop then prompt, reconnect, saved session, queue capability, shutdown')
