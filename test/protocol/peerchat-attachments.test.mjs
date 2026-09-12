import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  attachmentDriveName,
  decryptAttachment,
  deriveAttachmentKey,
  encryptAttachment,
  isEncryptedAttachment,
  openPeerChatAttachment,
  opaqueAttachmentPath,
  uploadPeerChatAttachment
} from '../../backend/peerchat/attachments.mjs'

const ROOM_KEY = 'ab'.repeat(32)
const OTHER_ROOM_KEY = 'cd'.repeat(32)
const DRIVE_ID = 'a'.repeat(52)

test('PeerChat attachment crypto matches the desktop wire contract', () => {
  const expectedDriveName = `peerchat-${createHash('sha256')
    .update(`peersky-chat:drive:${ROOM_KEY}`)
    .digest('hex')
    .slice(0, 32)}`
  assert.equal(attachmentDriveName(ROOM_KEY.toUpperCase()), expectedDriveName)
  assert.deepEqual(
    deriveAttachmentKey(ROOM_KEY),
    createHash('sha256').update(`peersky-chat:attachment:${ROOM_KEY}`).digest()
  )

  const plaintext = Buffer.from('private room attachment')
  const encrypted = encryptAttachment(plaintext, ROOM_KEY, Buffer.alloc(12, 7))
  assert.equal(encrypted.subarray(0, 4).toString(), 'PCA1')
  assert.equal(isEncryptedAttachment(encrypted), true)
  assert.deepEqual(decryptAttachment(encrypted, ROOM_KEY), plaintext)
  assert.throws(() => decryptAttachment(encrypted, OTHER_ROOM_KEY), /decryption failed/)
  assert.match(opaqueAttachmentPath(() => 123, () => Buffer.alloc(8, 9)), /^\/123-0909090909090909[.]bin$/)
})

test('PeerChat streams encrypted files through a room-specific drive and decrypts on open', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'peersky-peerchat-attachment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pickerDirectory = path.join(root, 'cache', 'documentpicker')
  await mkdir(pickerDirectory, { recursive: true })
  const sourcePath = path.join(pickerDirectory, 'report.txt')
  const plaintext = Buffer.from('streamed attachment contents')
  await writeFile(sourcePath, plaintext)

  const stored = new Map()
  const drive = {
    id: DRIVE_ID,
    createWriteStream (pathname) {
      const chunks = []
      return new Writable({
        write (chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk))
          callback()
        },
        final (callback) {
          stored.set(pathname, Buffer.concat(chunks))
          callback()
        }
      })
    },
    createReadStream (pathname) {
      return Readable.from([stored.get(pathname).subarray(0, 9), stored.get(pathname).subarray(9)])
    },
    async entry (pathname) {
      const bytes = stored.get(pathname)
      return bytes ? { value: { blob: { byteLength: bytes.byteLength } } } : null
    }
  }
  const requestedDrives = []
  const runtime = {
    async getDrive (name) {
      requestedDrives.push(name)
      return drive
    }
  }

  const uploaded = await uploadPeerChatAttachment({
    roomKey: ROOM_KEY,
    fileUri: pathToFileURL(sourcePath).toString(),
    byteLength: plaintext.byteLength
  }, {
    runtime,
    now: () => 123,
    randomBytes: () => Buffer.alloc(8, 9)
  })
  assert.equal(uploaded.ok, true)
  assert.equal(requestedDrives[0], attachmentDriveName(ROOM_KEY))
  assert.equal(isEncryptedAttachment(stored.values().next().value), true)
  assert.equal(stored.values().next().value.includes(plaintext), false)

  const opened = await openPeerChatAttachment({
    roomKey: ROOM_KEY,
    url: uploaded.item.url,
    fileName: 'report.txt',
    fileSize: plaintext.byteLength,
    encrypted: true
  }, { runtime, storagePath: root })
  assert.equal(opened.ok, true)
  assert.deepEqual(await readFile(new URL(opened.localUri)), plaintext)

  const wrongRoom = await openPeerChatAttachment({
    roomKey: OTHER_ROOM_KEY,
    url: uploaded.item.url,
    fileName: 'report.txt',
    fileSize: plaintext.byteLength,
    encrypted: true
  }, { runtime, storagePath: root })
  assert.equal(wrongRoom.ok, false)
  assert.match(wrongRoom.error, /decryption failed/)
})
