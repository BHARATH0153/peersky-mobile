import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  RPC_HYPER_CREATE_DRIVE,
  RPC_HYPER_FETCH,
  RPC_HYPER_INIT,
  RPC_HYPER_LIBRARY_LIST,
  RPC_HYPER_LIBRARY_UPLOAD,
  RPC_HYPER_LAN_STATUS,
  RPC_HYPER_OFFLINE_KEEP,
  RPC_HYPER_OFFLINE_LIST,
  RPC_HYPER_OFFLINE_PAUSE,
  RPC_HYPER_OFFLINE_RESUME,
  RPC_HYPER_OFFLINE_RESUME_ALL,
  RPC_HYPER_REFRESH,
  RPC_HYPER_STORAGE_CLEAR_ALL,
  RPC_HYPER_STORAGE_CLEAR_CACHE,
  RPC_HYPER_STORAGE_DELETE_APP,
  RPC_HYPER_STORAGE_LIST,
  RPC_PEERCHAT_INIT,
  RPC_PEERCHAT_DM_ACCEPT,
  RPC_PEERCHAT_DM_CREATE,
  RPC_PEERCHAT_DM_REJECT,
  RPC_PEERCHAT_PROFILE_SET,
  RPC_PEERCHAT_ROOM_CREATE,
  RPC_PEERCHAT_ROOM_JOIN,
  RPC_PEERCHAT_ROOMS,
  RPC_PEERCHAT_SNAPSHOT,
  RPC_PEERCHAT_SEND,
  RPC_PEERCHAT_ROOM_LEAVE,
  RPC_PEERCHAT_REACT,
  RPC_PEERCHAT_SET_ACTIVE,
  RPC_PEERCHAT_ROOM_PIN,
  RPC_PEERCHAT_ROOM_MUTE,
  RPC_PEERCHAT_ROOM_UPDATE
} from '../../backend/rpc/commands.mjs'

test('Hyper storage and LAN discovery use distinct RPC command IDs', () => {
  const commands = [
    RPC_HYPER_INIT,
    RPC_HYPER_FETCH,
    RPC_HYPER_CREATE_DRIVE,
    RPC_HYPER_STORAGE_LIST,
    RPC_HYPER_STORAGE_DELETE_APP,
    RPC_HYPER_STORAGE_CLEAR_CACHE,
    RPC_HYPER_LIBRARY_LIST,
    RPC_HYPER_LIBRARY_UPLOAD,
    RPC_HYPER_LAN_STATUS,
    RPC_HYPER_STORAGE_CLEAR_ALL,
    RPC_HYPER_REFRESH,
    RPC_HYPER_OFFLINE_LIST,
    RPC_HYPER_OFFLINE_KEEP,
    RPC_HYPER_OFFLINE_PAUSE,
    RPC_HYPER_OFFLINE_RESUME,
    RPC_HYPER_OFFLINE_RESUME_ALL
  ]

  assert.deepEqual(commands, [1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 60, 61, 62, 63, 64])
  assert.equal(new Set(commands).size, commands.length)
})

test('Hyper offline RPC commands route to the offline manager', async () => {
  const router = await readFile(
    new URL('../../backend/rpc/router.mjs', import.meta.url),
    'utf8'
  )

  const routes = [
    [RPC_HYPER_OFFLINE_LIST, 'RPC_HYPER_OFFLINE_LIST', 'listHyperOffline'],
    [RPC_HYPER_OFFLINE_KEEP, 'RPC_HYPER_OFFLINE_KEEP', 'keepHyperOffline'],
    [RPC_HYPER_OFFLINE_PAUSE, 'RPC_HYPER_OFFLINE_PAUSE', 'pauseHyperOffline'],
    [RPC_HYPER_OFFLINE_RESUME, 'RPC_HYPER_OFFLINE_RESUME', 'resumeHyperOffline'],
    [RPC_HYPER_OFFLINE_RESUME_ALL, 'RPC_HYPER_OFFLINE_RESUME_ALL', 'resumeWantedHyperOffline']
  ]

  for (const [command, commandName, handlerName] of routes) {
    assert.equal(Number.isSafeInteger(command), true)
    assert.match(router, new RegExp(`req[.]command === ${commandName}`))
    assert.match(router, new RegExp(`await ${handlerName}[(]parseJsonMessage[(]req[.]data[)][)]`))
  }
})

test('Hyper initialization resumes wanted offline downloads in the background', async () => {
  const router = await readFile(
    new URL('../../backend/rpc/router.mjs', import.meta.url),
    'utf8'
  )
  const initRoute = router.slice(
    router.indexOf('req.command === RPC_HYPER_INIT'),
    router.indexOf('req.command === RPC_HYPER_FETCH')
  )

  assert.match(initRoute, /replyJson[(]req,[\s\S]*resumeWantedHyperOffline[(][)]/)
  assert.match(initRoute, /resumeWantedHyperOffline[(][)][.]catch/)
})

test('PeerChat RPC commands use a dedicated command range', () => {
  const commands = [
    RPC_PEERCHAT_INIT,
    RPC_PEERCHAT_PROFILE_SET,
    RPC_PEERCHAT_ROOM_CREATE,
    RPC_PEERCHAT_ROOM_JOIN,
    RPC_PEERCHAT_ROOMS,
    RPC_PEERCHAT_SNAPSHOT,
    RPC_PEERCHAT_SEND,
    RPC_PEERCHAT_ROOM_LEAVE,
    RPC_PEERCHAT_REACT,
    RPC_PEERCHAT_SET_ACTIVE,
    RPC_PEERCHAT_ROOM_PIN,
    RPC_PEERCHAT_ROOM_MUTE,
    RPC_PEERCHAT_ROOM_UPDATE,
    RPC_PEERCHAT_DM_CREATE,
    RPC_PEERCHAT_DM_ACCEPT,
    RPC_PEERCHAT_DM_REJECT
  ]

  assert.deepEqual(commands, [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55])
  assert.equal(new Set(commands).size, commands.length)
})
