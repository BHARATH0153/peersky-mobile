import assert from 'node:assert/strict'
import { test } from 'node:test'

import { refreshHyperRuntimeNetwork } from '../../backend/hyper/network-refresh.mjs'

test('resumes the runtime and refreshes active discovery sessions', async () => {
  const events = []
  const runtime = {
    resume: async () => { events.push('resume') },
    swarm: {
      topics: () => [
        { refresh: async () => { events.push('first') } },
        { refresh: async () => { events.push('second') } }
      ]
    }
  }

  const result = await refreshHyperRuntimeNetwork(runtime)

  assert.equal(result.timedOut, false)
  assert.equal(result.discoveries, 2)
  assert.equal(events[0], 'resume')
  assert.deepEqual(events.slice(1).sort(), ['first', 'second'])
})

test('deduplicates overlapping refreshes for the same runtime', async () => {
  let refreshes = 0
  let release
  const runtime = {
    swarm: {
      topics: () => [{
        refresh: async () => {
          refreshes++
          await new Promise((resolve) => { release = resolve })
        }
      }]
    }
  }

  const first = refreshHyperRuntimeNetwork(runtime)
  const second = refreshHyperRuntimeNetwork(runtime)
  await Promise.resolve()
  release()

  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(refreshes, 1)
})

test('bounds a stalled discovery refresh', async () => {
  const runtime = {
    swarm: {
      topics: () => [{ refresh: () => new Promise(() => {}) }]
    }
  }

  const result = await refreshHyperRuntimeNetwork(runtime, { timeoutMs: 5 })
  assert.equal(result.timedOut, true)
})
