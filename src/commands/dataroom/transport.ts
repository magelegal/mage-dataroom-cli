/**
 * How `mage upload` moves bytes: direct-to-S3 multipart by default, with the
 * proxied whole-body POST as the fallback.
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
 * block direct PUTs to storage. A short connectivity probe — one tiny PUT to a
 * throwaway presigned URL — decides the path once per invocation; a probe
 * failure selects the proxied fallback, and a mid-file storage failure on the
 * direct path falls back per-file the same way.
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { DocumentSummary, DocUploadPart, MageClient } from '../../client'
import { formatBytes, type UploadItem } from '../../walk'

export type UploadMode = 'direct' | 'proxied'

// PAIRED LIMIT: the server enforces the same per-file ceiling on the initiate
// endpoint; checking here turns a doomed upload into an instant, clear error.
export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024 // 100GB
// PAIRED LIMIT: the server's body ceiling on the proxied document POST. Only
// the fallback path is bound by it — direct multipart carries files to the
// full MAX_FILE_SIZE.
export const PROXIED_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024 // 5GB

// The probe PUTs a few bytes to storage; a locked-down proxy usually hangs
// rather than rejecting outright, so cap the wait tightly.
const PROBE_TIMEOUT_MS = 4000
const PART_ATTEMPTS = 3

/** A storage-leg failure on the direct path — the signal to fall back to the
    proxied upload for this file. API-side failures (initiate/complete) are
    NOT this: the fallback talks to the same API, so they stay fatal. */
export class DirectUploadUnavailable extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DirectUploadUnavailable'
  }
}

/**
 * Decide the upload path for this invocation.
 *
 * `MAGE_UPLOAD_MODE=direct|proxied` skips the probe (a user on a network they
 * already understand shouldn't pay for or depend on a probe). Otherwise probe
 * once: PUT succeeds → direct; PUT fails/times out → proxied; the probe-issue
 * call itself failing → direct — that's an API or auth hiccup, not evidence of
 * a blocked storage path, and the direct path has its own per-file fallback.
 */
export async function resolveUploadMode(client: MageClient, roomId: string): Promise<UploadMode> {
  const forced = process.env.MAGE_UPLOAD_MODE?.trim().toLowerCase()
  if (forced === 'direct' || forced === 'proxied') return forced

  let probe: { url: string; byteLength: number }
  try {
    probe = await client.getUploadProbe(roomId)
  } catch {
    return 'direct'
  }
  try {
    const res = await fetch(probe.url, {
      method: 'PUT',
      // Exactly the byte count the URL was signed for — any other size is a
      // signature mismatch, which would misread a healthy network as blocked.
      body: new Uint8Array(probe.byteLength),
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.ok ? 'direct' : 'proxied'
  } catch {
    return 'proxied'
  }
}

/** SHA-256 hex digest, streamed so the file is never whole in memory. The
    server records it at complete so content dedup matches immediately —
    the proxied path computes the same digest server-side. */
async function hashFile(absPath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** PUT one part, re-signing once on an expired URL and retrying transient
    failures. Returns the part's ETag. */
async function putPart(
  client: MageClient,
  roomId: string,
  uploadId: string,
  partNumber: number,
  url: string | undefined,
  body: Uint8Array,
): Promise<string> {
  let partUrl = url
  let lastFailure = 'part upload failed'
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    if (!partUrl) {
      // Missing or expired URL — ask the API for a fresh one. An API failure
      // here propagates: the fallback path would hit the same API.
      partUrl = (await client.signDocumentUploadPart(roomId, uploadId, partNumber)).presignedUrl
    }
    try {
      const res = await fetch(partUrl, { method: 'PUT', body })
      if (res.ok) {
        // S3 returns the ETag quoted; the API echoes it back unquoted.
        const etag = res.headers.get('etag')?.replace(/"/g, '')
        if (etag) return etag
        lastFailure = 'storage returned no ETag for the uploaded part'
      } else {
        lastFailure = `storage rejected part ${partNumber} (HTTP ${res.status})`
        // A 403 is an expired presign — drop the URL so the next attempt re-signs.
        if (res.status === 403) partUrl = undefined
      }
    } catch (err) {
      lastFailure = (err as Error).message
    }
  }
  throw new DirectUploadUnavailable(lastFailure)
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

/** Upload one file via the proxied whole-body POST (the fallback path). */
export async function uploadFileProxied(
  client: MageClient,
  roomId: string,
  item: UploadItem,
): Promise<DocumentSummary> {
  const content = readFileSync(item.absPath)
  if (content.byteLength > PROXIED_MAX_FILE_SIZE) {
    throw new Error(
      `${item.filename} is ${formatBytes(content.byteLength)} — over the ` +
        `${formatBytes(PROXIED_MAX_FILE_SIZE)} limit of the fallback upload path. ` +
        `This network blocks direct-to-storage uploads, which carry larger files.`,
    )
  }
  return client.uploadDocument(roomId, {
    filename: item.filename,
    content,
    folderPath: item.folderPath,
  })
}

/**
 * Upload one file on the resolved path. On `direct`, a storage-leg failure
 * falls back to the proxied POST for this file (the API never saw the failed
 * attempt, so nothing was created); API failures propagate unchanged.
 * Returns the created document and which transport carried it, so the caller
 * can surface the downgrade.
 */
export async function uploadFile(
  client: MageClient,
  roomId: string,
  item: UploadItem,
  mode: UploadMode,
): Promise<{ doc: DocumentSummary; transport: UploadMode }> {
  const { size } = await stat(item.absPath)
  if (size === 0) throw new Error(`${item.filename} is empty.`)
  if (size > MAX_FILE_SIZE) {
    throw new Error(
      `${item.filename} is ${formatBytes(size)} — over the ${formatBytes(MAX_FILE_SIZE)} per-file limit.`,
    )
  }

  if (mode === 'direct') {
    try {
      return { doc: await uploadFileDirect(client, roomId, item), transport: 'direct' }
    } catch (err) {
      if (!(err instanceof DirectUploadUnavailable)) throw err
    }
  }
  return { doc: await uploadFileProxied(client, roomId, item), transport: 'proxied' }
}
