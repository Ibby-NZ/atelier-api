/**
 * Minimal ZIP reader — enough to pull named entries out of an .xlsx.
 *
 * Node has no bundled zip reader, but it does bundle `zlib`, and an xlsx is a
 * plain (non-ZIP64, no encryption) archive of deflated XML. So the whole reader
 * is: locate the End Of Central Directory record, walk the central directory,
 * then `inflateRawSync` the one member we want. That keeps the converters
 * dependency-free, matching the posture of the Python versions they replace.
 *
 * Anything outside that envelope (ZIP64, an unknown compression method) throws
 * rather than silently returning wrong bytes.
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_COMMENT = 0xffff

const STORED = 0
const DEFLATED = 8

const findEndOfCentralDirectory = (buffer) => {
  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT)
  for (let at = buffer.length - EOCD_MIN_SIZE; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at
  }
  throw new Error('not a zip archive (no end-of-central-directory record)')
}

const readCentralDirectory = (buffer) => {
  const eocd = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  const start = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || start === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported')
  }

  const entries = new Map()
  let at = start
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at byte ${at}`)
    }
    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    entries.set(name, { method, compressedSize, localOffset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Open an in-memory archive. Returns `{ has(name), read(name) }`; `read`
 * yields a Buffer and throws when the entry is missing.
 */
export const openZip = (buffer) => {
  const entries = readCentralDirectory(buffer)

  const read = (name) => {
    const entry = entries.get(name)
    if (!entry) throw new Error(`zip entry not found: ${name}`)
    const { localOffset } = entry
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`corrupt local header for ${name}`)
    }
    const nameLength = buffer.readUInt16LE(localOffset + 26)
    const extraLength = buffer.readUInt16LE(localOffset + 28)
    const from = localOffset + 30 + nameLength + extraLength
    const raw = buffer.subarray(from, from + entry.compressedSize)
    if (entry.method === STORED) return Buffer.from(raw)
    if (entry.method === DEFLATED) return inflateRawSync(raw)
    throw new Error(`unsupported compression method ${entry.method} for ${name}`)
  }

  return { has: (name) => entries.has(name), read }
}
