import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import b4a from 'b4a'

import {
  getHyperStoragePath,
  withHyperRuntimeForAddress,
  withHyperRuntimeOperation
} from '../hyper/runtime.mjs'
import { createHyperUrl, parseHyperUrl } from '../hyper/url.mjs'
import { normalizePeerChatRoomKey } from './protocol.mjs'

const ATTACHMENT_KEY_CONTEXT = 'peersky-chat:attachment:'
const DRIVE_NAME_CONTEXT = 'peersky-chat:drive:'
const MAGIC = b4a.from('PCA1')
const IV_BYTES = 12
const TAG_BYTES = 16
const ENVELOPE_BYTES = MAGIC.byteLength + IV_BYTES + TAG_BYTES
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_FILE_URI_LENGTH = 8192
const CACHE_DIRECTORY_NAME = 'peerchat-attachment-cache'
let uploadTransition = Promise.resolve()
const pendingOpens = new Map()

export function attachmentDriveName (roomKey) {
  const normalizedRoomKey = requireRoomKey(roomKey)
  return `peerchat-${createHash('sha256')
    .update(DRIVE_NAME_CONTEXT + normalizedRoomKey)
    .digest('hex')
    .slice(0, 32)}`
}

export function deriveAttachmentKey (roomKey) {
  return createHash('sha256')
    .update(ATTACHMENT_KEY_CONTEXT + requireRoomKey(roomKey))
    .digest()
}

export function opaqueAttachmentPath (now = Date.now, random = randomBytes) {
  return `/${now()}-${b4a.toString(random(8), 'hex')}.bin`
}

export function isEncryptedAttachment (bytes) {
  return bytes instanceof Uint8Array &&
    bytes.byteLength >= ENVELOPE_BYTES &&
    MAGIC.every((byte, index) => bytes[index] === byte)
}

export function encryptAttachment (bytes, roomKey, iv = randomBytes(IV_BYTES)) {
  const cipher = createCipheriv('aes-256-gcm', deriveAttachmentKey(roomKey), iv)
  const ciphertext = b4a.concat([cipher.update(bytes), cipher.final()])
  return b4a.concat([MAGIC, iv, ciphertext, cipher.getAuthTag()])
}

export function decryptAttachment (bytes, roomKey) {
  if (!isEncryptedAttachment(bytes)) throw new Error('Not an encrypted PeerChat attachment.')
  const iv = bytes.subarray(MAGIC.byteLength, MAGIC.byteLength + IV_BYTES)
  const sealed = bytes.subarray(MAGIC.byteLength + IV_BYTES)
  const ciphertext = sealed.subarray(0, sealed.byteLength - TAG_BYTES)
  const tag = sealed.subarray(sealed.byteLength - TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveAttachmentKey(roomKey), iv)
    decipher.setAuthTag(tag)
    return b4a.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('PeerChat attachment decryption failed.')
  }
}

export async function uploadPeerChatAttachment ({
  roomKey,
  fileUri,
  byteLength
} = {}, options = {}) {
  const normalizedRoomKey = normalizePeerChatRoomKey(roomKey)
  if (!normalizedRoomKey) return { ok: false, error: 'Invalid PeerChat room key.' }
  const localFile = normalizeLocalFile(fileUri, byteLength)
  if (!localFile) return { ok: false, error: 'Invalid attachment file.' }
  if (localFile.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: 'PeerChat attachments must be 2 GB or smaller.' }
  }

  return withUploadTransition(async () => {
    try {
      return await runWithRuntime(options, async (runtime) => {
        const drive = await runtime.getDrive(attachmentDriveName(normalizedRoomKey))
        const pathname = opaqueAttachmentPath(options.now, options.randomBytes)
        await writeEncryptedFile(drive, pathname, localFile, normalizedRoomKey, options)

        const storedEntry = await drive.entry(pathname)
        const expectedLength = localFile.byteLength + ENVELOPE_BYTES
        if (storedEntry?.value?.blob?.byteLength !== expectedLength) {
          throw new Error('The encrypted attachment could not be verified.')
        }

        return {
          ok: true,
          item: {
            url: createHyperUrl(`hyper://${drive.id}/`, pathname),
            byteLength: localFile.byteLength
          }
        }
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

export async function openPeerChatAttachment ({
  roomKey,
  url,
  fileName,
  fileSize,
  encrypted
} = {}, options = {}) {
  const normalizedRoomKey = normalizePeerChatRoomKey(roomKey)
  if (!normalizedRoomKey) return { ok: false, error: 'Invalid PeerChat room key.' }
  const target = parseHyperUrl(url)
  if (target.error || target.pathname === '/' || target.pathname.endsWith('/')) {
    return { ok: false, error: target.error || 'Invalid PeerChat attachment URL.' }
  }

  const normalizedName = normalizeFilename(fileName)
  if (!normalizedName) return { ok: false, error: 'Invalid attachment name.' }
  if (encrypted !== true) return { ok: false, error: 'Attachment is not marked as encrypted.' }
  const expectedSize = Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : null
  if (expectedSize !== null && expectedSize > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: 'PeerChat attachments must be 2 GB or smaller.' }
  }

  const openingKey = `${normalizedRoomKey}:${url}`
  const pending = pendingOpens.get(openingKey)
  if (pending) return pending

  const opening = runWithRuntime(options, async (runtime) => {
    const drive = await runtime.getDrive(target.driveAddress)
    const entry = await drive.entry(target.pathname)
    const storedSize = entry?.value?.blob?.byteLength
    if (!Number.isSafeInteger(storedSize) || storedSize < 1) {
      throw new Error('PeerChat attachment was not found.')
    }
    if (storedSize > MAX_ATTACHMENT_BYTES + ENVELOPE_BYTES) {
      throw new Error('PeerChat attachment is too large.')
    }

    const outputSize = storedSize - ENVELOPE_BYTES
    if (outputSize < 0 || (expectedSize !== null && outputSize !== expectedSize)) {
      throw new Error('PeerChat attachment size does not match the message.')
    }

    const cachePath = getAttachmentCachePath(normalizedRoomKey, url, normalizedName, options.storagePath)
    if (existsSync(cachePath) && statSync(cachePath).size === outputSize) {
      return { ok: true, localUri: toFileUri(cachePath), byteLength: outputSize }
    }

    mkdirSync(getDirName(cachePath), { recursive: true })
    const temporaryPath = `${cachePath}.partial`
    rmSync(temporaryPath, { force: true })
    try {
      const source = drive.createReadStream(target.pathname)
      await pipeline(
        source,
        new AttachmentDecryptStream(normalizedRoomKey),
        createWriteStream(temporaryPath)
      )
      if (statSync(temporaryPath).size !== outputSize) {
        throw new Error('PeerChat attachment download was incomplete.')
      }
      rmSync(cachePath, { force: true })
      renameSync(temporaryPath, cachePath)
    } catch (error) {
      rmSync(temporaryPath, { force: true })
      throw error
    }

    return { ok: true, localUri: toFileUri(cachePath), byteLength: outputSize }
  }, target.driveAddress)
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    .finally(() => pendingOpens.delete(openingKey))
  pendingOpens.set(openingKey, opening)
  return opening
}

class AttachmentEncryptStream extends Transform {
  constructor (roomKey, iv = randomBytes(IV_BYTES)) {
    super()
    this.cipher = createCipheriv('aes-256-gcm', deriveAttachmentKey(roomKey), iv)
    this.push(MAGIC)
    this.push(iv)
  }

  _transform (chunk, encoding, callback) {
    try {
      this.push(this.cipher.update(chunk))
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush (callback) {
    try {
      this.push(this.cipher.final())
      this.push(this.cipher.getAuthTag())
      callback()
    } catch (error) {
      callback(error)
    }
  }
}

class AttachmentDecryptStream extends Transform {
  constructor (roomKey) {
    super()
    this.key = deriveAttachmentKey(roomKey)
    this.header = b4a.alloc(0)
    this.tail = b4a.alloc(0)
    this.decipher = null
  }

  _transform (chunk, encoding, callback) {
    try {
      let bytes = b4a.from(chunk)
      if (!this.decipher) {
        const combined = b4a.concat([this.header, bytes])
        if (combined.byteLength < MAGIC.byteLength + IV_BYTES) {
          this.header = combined
          callback()
          return
        }
        if (!MAGIC.every((byte, index) => combined[index] === byte)) {
          throw new Error('Invalid encrypted PeerChat attachment header.')
        }
        const iv = combined.subarray(MAGIC.byteLength, MAGIC.byteLength + IV_BYTES)
        this.decipher = createDecipheriv('aes-256-gcm', this.key, iv)
        bytes = combined.subarray(MAGIC.byteLength + IV_BYTES)
        this.header = b4a.alloc(0)
      }

      const sealed = b4a.concat([this.tail, bytes])
      if (sealed.byteLength > TAG_BYTES) {
        const ciphertextEnd = sealed.byteLength - TAG_BYTES
        this.push(this.decipher.update(sealed.subarray(0, ciphertextEnd)))
        this.tail = sealed.subarray(ciphertextEnd)
      } else {
        this.tail = sealed
      }
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush (callback) {
    try {
      if (!this.decipher || this.tail.byteLength !== TAG_BYTES) {
        throw new Error('Encrypted PeerChat attachment is incomplete.')
      }
      this.decipher.setAuthTag(this.tail)
      this.push(this.decipher.final())
      callback()
    } catch {
      callback(new Error('PeerChat attachment decryption failed.'))
    }
  }
}

async function writeEncryptedFile (drive, pathname, localFile, roomKey, options) {
  if (options.writeEncryptedFile) {
    await options.writeEncryptedFile({ drive, pathname, localFile, roomKey })
    return
  }
  const stat = statSync(localFile.path)
  if (!stat.isFile() || stat.size !== localFile.byteLength) {
    throw new Error('The selected attachment changed before upload.')
  }
  await pipeline(
    createReadStream(localFile.path),
    new AttachmentEncryptStream(roomKey),
    drive.createWriteStream(pathname)
  )
}

function normalizeLocalFile (fileUri, byteLength) {
  if (
    typeof fileUri !== 'string' ||
    fileUri.length < 1 ||
    fileUri.length > MAX_FILE_URI_LENGTH ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1
  ) return null

  try {
    const parsed = new URL(fileUri)
    if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search || parsed.hash) return null
    const decodedPath = decodeURIComponent(parsed.pathname)
    const path = /^\/[a-z]:\//i.test(decodedPath) ? decodedPath.slice(1) : decodedPath
    const normalizedPath = path.replaceAll('\\', '/')
    if (
      normalizedPath.includes('\0') ||
      normalizedPath.split('/').some((segment) => segment === '..') ||
      !/\/(?:cache|caches)\/documentpicker\//i.test(normalizedPath)
    ) return null
    return { path, byteLength }
  } catch {
    return null
  }
}

function normalizeFilename (value) {
  if (typeof value !== 'string') return ''
  const sanitized = Array.from(value.trim())
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && (code < 127 || code > 159)
    })
    .join('')
    .replace(/[/\\?#]/g, '-')
    .replace(/^[. -]+|[. ]+$/g, '')
  return Array.from(sanitized).slice(0, 160).join('')
}

function getAttachmentCachePath (roomKey, url, fileName, suppliedStoragePath) {
  const storagePath = suppliedStoragePath || getHyperStoragePath() || '.'
  const fingerprint = createHash('sha256').update(`${roomKey}:${url}`).digest('hex').slice(0, 24)
  return `${String(storagePath).replace(/[/\\]+$/, '')}/${CACHE_DIRECTORY_NAME}/${fingerprint}-${fileName}`
}

function getDirName (path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? '.' : path.slice(0, index)
}

function toFileUri (path) {
  const normalized = String(path).replaceAll('\\', '/')
  return `file://${encodeURI(normalized.startsWith('/') ? normalized : `/${normalized}`)}`
}

function requireRoomKey (roomKey) {
  const normalized = normalizePeerChatRoomKey(roomKey)
  if (!normalized) throw new Error('Invalid PeerChat room key.')
  return normalized
}

function runWithRuntime (options, operation, address) {
  if (options.runtime) return operation(options.runtime)
  return address
    ? withHyperRuntimeForAddress(address, operation)
    : withHyperRuntimeOperation(operation)
}

function withUploadTransition (task) {
  const next = uploadTransition.then(task, task)
  uploadTransition = next.catch(() => {})
  return next
}
