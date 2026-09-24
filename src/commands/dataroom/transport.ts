/**
 * How `mage upload` moves bytes: direct-to-storage multipart, one part at a
 * time, with the API as the second road for a part storage never answered.
 *
 * The direct path PUTs each file straight to storage against presigned part
 * URLs, then asks the API to assemble it — the same transport the web app
 * uses. Keeping large bodies out of a single API request matters beyond
 * throughput: a whole-file POST rides one connection through every proxy and
 * network hop between the user and the API, and one interrupted transfer
 * fails the entire file. Parts upload independently and each part retries on
 * its own, so a flaky hop costs a re-sent part instead of the upload.
 *
 * Some locked-down networks (VPNs, forward proxies, DLP appliances) silently
 * block direct PUTs to storage. The evidence is a part PUT that gets no
 * response at all: that part goes to the API's relay route instead, which
 * writes it to the same upload, and the rest of this run's parts follow it
 * there. A relayed part that also gets no response unpins the run, because a
 * machine that is simply offline fails both roads alike. A storage answer,
 * such as a 403 for an expired URL, is never that evidence: it re-signs.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { ApiError, type DocumentSummary, type DocUploadPart, type MageClient } from '../../client'
import { formatBytes, type UploadItem } from '../../walk'

// PAIRED LIMIT: the server enforces the same per-file ceiling on the initiate
// endpoint; checking here turns a doomed upload into an instant, clear error.
export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024 // 100GB

const PART_ATTEMPTS = 3

/** The pause before retry N (N = 1, 2, …) on the same road: 0.5 s, then 1 s.
    Short enough that a user never wonders if it hung, long enough that a
    network blip has a moment to clear instead of eating all three tries. */
const RETRY_PAUSE_MS = 500

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let pause: (ms: number) => Promise<void> = sleep

/** Tests only: record the pauses instead of sleeping them. No argument
    restores the real pause. */
export function setRetryPause(fn?: (ms: number) => Promise<void>): void {
  pause = fn ?? sleep
}

/** The error a part fails with when neither storage nor the API's relay gave
    any response: plain words, the network's own reason, and what to do. A
    re-run is safe, since files already in the room are left as they are. */
export function bothRoadsFailedMessage(reason?: string): string {
  return (
    `Could not upload this file. Storage and the Mage API did not answer` +
    `${reason ? ` (${reason})` : ''}. ` +
    `Check your internet, VPN, or proxy, then run the same upload again.`
  )
}

/** Why a part attempt failed, ranked by how much it tells the user. A later
    attempt's failure replaces an earlier one only when it says at least as
    much, so a bare "fetch failed" never buries a clearer sentence. */
interface PartFailure {
  rank: number
  message: string
}
const NO_RESPONSE = 0 // storage never answered: the runtime's raw error
const STORAGE_ANSWER = 1 // storage answered with an error, or no ETag
const RELAY_ANSWER = 2 // the API relay answered with a server error
const BOTH_SILENT = 3 // the relay never answered either

/** Which road this run's parts take. Pinned by a storage PUT that got no
    response; unpinned by a relayed PUT that got none either. The pin lasts as
    long as the process: one `mage upload`, or a whole MCP server session, the
    same lifetime the browser's session pin has. */
let relayPinned = false

/** Does this run send its parts through the API? */
export function isRelayPinned(): boolean {
  return relayPinned
}

/** Tests only: a fresh run starts on the direct road. */
export function resetRelayPin(): void {
  relayPinned = false
}

/** SHA-256 hex digest, streamed so the file is never whole in memory. The
    server records it at complete so content dedup matches immediately. */
async function hashFile(absPath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** One attempt on the relay road. Returns the ETag, or the reason to try
    again. A verdict the API issued (a 410 for a forgotten session, a 413)
    is final and propagates; a relay that got no response unpins the run. */
async function relayOnce(
  client: MageClient,
  roomId: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<{ etag: string } | { retry: PartFailure }> {
  try {
    return { etag: await client.relayDocumentUploadPart(roomId, uploadId, partNumber, body) }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (err.status === 0) {
      relayPinned = false
      return { retry: { rank: BOTH_SILENT, message: bothRoadsFailedMessage(err.reason) } }
    }
    if (err.status >= 500) return { retry: { rank: RELAY_ANSWER, message: err.detail } }
    throw err
  }
}

/** PUT one part, re-signing on an expired URL, relaying through the API when
    storage never answers, and retrying transient failures. Returns the
    part's ETag. */
async function putPart(
  client: MageClient,
  roomId: string,
  uploadId: string,
  partNumber: number,
  url: string | undefined,
  body: Uint8Array,
): Promise<string> {
  let partUrl = url
  let failure: PartFailure = { rank: NO_RESPONSE, message: 'part upload failed' }
  const fail = (next: PartFailure) => {
    if (next.rank >= failure.rank) failure = next
  }
  // Whether the next attempt should wait first. A switch to the relay and a
  // re-signed URL are fixes, not retries of the same thing, so they go at once.
  let waitFirst = false
  let retries = 0
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    if (waitFirst) {
      retries += 1
      await pause(RETRY_PAUSE_MS * 2 ** (retries - 1))
    }
    waitFirst = true
    if (relayPinned) {
      const relayed = await relayOnce(client, roomId, uploadId, partNumber, body)
      if ('etag' in relayed) return relayed.etag
      fail(relayed.retry)
      continue
    }
    if (!partUrl) {
      // Missing or expired URL — ask the API for a fresh one. An API failure
      // here propagates.
      partUrl = (await client.signDocumentUploadPart(roomId, uploadId, partNumber)).presignedUrl
    }
    let res: Response
    try {
      res = await fetch(partUrl, { method: 'PUT', body })
    } catch (err) {
      // No response at all: the network in between refused a direct write.
      // This part, and the run's later parts, go through the API instead.
      relayPinned = true
      fail({ rank: NO_RESPONSE, message: (err as Error).message })
      waitFirst = false
      continue
    }
    if (res.ok) {
      // S3 returns the ETag quoted; the API echoes it back unquoted.
      const etag = res.headers.get('etag')?.replace(/"/g, '')
      if (etag) return etag
      fail({ rank: STORAGE_ANSWER, message: 'storage returned no ETag for the uploaded part' })
    } else {
      fail({ rank: STORAGE_ANSWER, message: `storage rejected part ${partNumber} (HTTP ${res.status})` })
      // A 403 is an expired presign — drop the URL so the next attempt re-signs.
      if (res.status === 403) {
        partUrl = undefined
        waitFirst = false
      }
    }
  }
  throw new Error(failure.message)
}

/** Upload one file via direct-to-S3 multipart: initiate → PUT parts → complete. */
export async function uploadFileDirect(
  client: MageClient,
  roomId: string,
  item: UploadItem,
): Promise<DocumentSummary> {
  const { size } = await stat(item.absPath)
  const fileHash = await hashFile(item.absPath)
  const plan = await client.initiateDocumentUpload(roomId, {
    filename: item.filename,
    fileSize: size,
  })

  const parts: DocUploadPart[] = []
  const handle = await open(item.absPath, 'r')
  try {
    for (let partNumber = 1; partNumber <= plan.totalParts; partNumber++) {
      const position = (partNumber - 1) * plan.chunkSize
      const length = Math.min(plan.chunkSize, size - position)
      const buffer = Buffer.alloc(length)
      // read() may return fewer bytes than asked; loop until the part is full
      // (a short read silently uploaded would corrupt the assembled file).
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
        if (bytesRead === 0) throw new Error(`${item.filename} changed size while uploading`)
        filled += bytesRead
      }
      const etag = await putPart(
        client,
        roomId,
        plan.uploadId,
        partNumber,
        plan.presignedUrls[String(partNumber)],
        buffer,
      )
      parts.push({ partNumber, etag })
    }
  } finally {
    await handle.close()
  }

  return client.completeDocumentUpload(roomId, plan.uploadId, {
    parts,
    fileHash,
    folderPath: item.folderPath,
  })
}

/** Did the room already hold this file (same folder, name and bytes), so the
    upload made no new row? Read from the server's answer at complete; a server
    that never says reads as a new upload. */
export function wasAlreadyThere(doc: DocumentSummary): boolean {
  return doc.placement === 'existing'
}

/** Upload one file, refusing an empty or over-ceiling file before any request. */
export async function uploadFile(
  client: MageClient,
  roomId: string,
  item: UploadItem,
): Promise<DocumentSummary> {
  const { size } = await stat(item.absPath)
  if (size === 0) throw new Error(`${item.filename} is empty.`)
  if (size > MAX_FILE_SIZE) {
    throw new Error(
      `${item.filename} is ${formatBytes(size)}. That is over the ${formatBytes(MAX_FILE_SIZE)} per-file limit.`,
    )
  }
  return uploadFileDirect(client, roomId, item)
}
