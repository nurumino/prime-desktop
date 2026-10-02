import { expect, it, vi } from 'vitest'
import { DaemonTransport } from '../src/main/daemonTransport'

it('resumes prompt admission after Stop and preserves explicit delivery and images', async () => {
  let suspended = false
  const connection = {
    abort: vi.fn(async () => { suspended = true }),
    prompt: vi.fn(async (_text: string, options: { streamingBehavior?: string }) => {
      if (suspended && !options.streamingBehavior) throw new Error('Queued session input is suspended')
      suspended = false
    })
  }
  const transport = new DaemonTransport({} as never)
  Object.assign(transport, { started: true, connection })
  await transport.send({ type: 'abort' })
  await transport.send({ type: 'prompt', message: 'Continue' })
  expect(connection.prompt).toHaveBeenLastCalledWith('Continue', { images: undefined, streamingBehavior: 'followUp' })
  const images = [{ type: 'image', data: 'test', mimeType: 'image/png' }]
  await transport.send({ type: 'prompt', message: 'Steer', streamingBehavior: 'steer', images })
  expect(connection.prompt).toHaveBeenLastCalledWith('Steer', { images, streamingBehavior: 'steer' })
  await transport.send({ type: 'prompt', message: 'Later', streamingBehavior: 'followUp' })
  expect(connection.prompt).toHaveBeenLastCalledWith('Later', { images: undefined, streamingBehavior: 'followUp' })
  expect(connection.abort).toHaveBeenCalledTimes(1)
})
