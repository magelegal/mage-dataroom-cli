/**
 * Thin HTTP client over the Mage lite data-room API.
 *
 * All real logic lives server-side; this is a typed wrapper over the endpoints
 * the CLI reaches. Authentication is one of two headers:
 *
 *  - `X-API-Key` — the long-lived room-scoped key every data command uses.
 *  - `Authorization: Bearer <jwt>` — a short-lived WorkOS access token, used
 *    only by the control-plane commands (`login` / `rooms` / `use`) to act as
 *    the signed-in user: list the org's rooms and mint/revoke the CLI's key.
 */

/** A document row as the room's list/upload endpoints return it (camelCase wire). */
export interface DocumentSummary {
  id: string
  name: string
  status: string
  processingPhase: string | null
  folderPath: string | null
  litePageCount: number | null
  liteCategory: string | null
  indexNumber: string | null
  version: number
  externalSource: string | null
  createdAt: string
}

/** What a key resolves to — returned by the room-less `/cli/context` probe. */
export interface RoomContext {
  roomId: string
  roomName: string
  keyName: string
}

export interface FolderSet {
  folders: string[]
}

/** One readiness checklist item, as the coverage endpoint returns it. */
export interface CoverageItem {
  itemId: string
  label: string
  requirementLevel: string
  /** present | partial | missing | not_applicable */
  status: string
  /** The documents currently attached to the item. */
  matchedDocumentIds: string[]
  completed: boolean
  section: string
  expectedScope: string
  founderHint: string
  multiDoc: boolean
}

/** The room's readiness checklist (gap analysis) with per-item statuses. */
export interface Coverage {
  roomId: string
  /** False until the first analysis has run (right after documents arrive). */
  computed: boolean
  missingRequiredCount: number
  computedAt: string | null
  items: CoverageItem[]
}

/** A data room as the org-scoped rooms list returns it. */
export interface LiteRoom {
  id: string
  name: string
  companyName: string | null
  fundingStage: string | null
  documentCount: number
  status: string
  createdAt: string
  teamNdaRequired: boolean
  teamNdaAccepted: boolean
}

/** The signed-in user, from `/me` (which also provisions their org on first call). */
export interface LiteMe {
  userId: string
  email: string | null
  orgId: string | null
}

/** The mint response — the ONLY time the raw `key` is ever returned. */
export interface DocumentUrl {
  url: string
  isPdfDerivative: boolean
}

export interface MintedApiKey {
  id: string
  name: string
  keyPrefix: string
  key: string
  createdAt: string
}

/** Presigned plan for one document's direct-to-S3 multipart upload. The client
    slices the file into `totalParts` chunks of `chunkSize` bytes and PUTs each
    to its URL in `presignedUrls` (keyed by 1-based part number — JSON object
    keys, so strings on the wire). */
export interface DocUploadPlan {
  uploadId: string
  s3Key: string
  chunkSize: number
  totalParts: number
  presignedUrls: Record<string, string>
  expiresIn: number
}

/** One uploaded part's identity, echoed back to assemble the object. */
export interface DocUploadPart {
  partNumber: number
  etag: string
}

/** Presigned PUT target for the direct-to-S3 connectivity probe. The URL is
    signed for exactly `byteLength` bytes — send precisely that many. */
export interface UploadProbe {
  url: string
  key: string
  expiresIn: number
  byteLength: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'ApiError'
  }
}

// Error codes that mean the connection was never established — DNS, refused,
// unreachable, or a connect-phase timeout. Only these justify "could not
// reach"; anything after the connect (a reset, a broken pipe, a TLS failure
// mid-stream) means the service answered the dial and something interrupted
// the request in flight — usually a proxy, VPN, or unstable network, not an
// outage. Reporting those as "could not reach" sends the user to a status
// page when the actionable fix is their network path or a retry.
const NEVER_CONNECTED_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** Deepest cause with a message — undici wraps the real failure in layers of
    generic "fetch failed" TypeErrors. */
function rootCause(err: Error): { code?: string; message: string } {
  let code: string | undefined
  let message = err.message
  let cursor: unknown = err
  while (cursor instanceof Error) {
    const c = (cursor as Error & { code?: string }).code
    if (typeof c === 'string' && c.length > 0) code = c
    if (cursor.message) message = cursor.message
    cursor = cursor.cause
  }
  return { code, message }
}

/** One terse line for the parenthetical — TLS and socket errors carry
    multi-line library internals no user should have to read. */
function describeCause(code: string | undefined, message: string): string {
  const firstLine = (message.split('\n')[0] ?? '').trim()
  if (code && (firstLine.length > 80 || firstLine.length === 0)) return code
  if (code && !firstLine.includes(code)) return `${code}: ${firstLine}`
  return firstLine || 'unknown error'
}

/** Translate a thrown `fetch` into an ApiError whose message tells the truth
    about WHERE the request died. */
export function toFetchApiError(baseUrl: string, err: Error): ApiError {
  const { code, message } = rootCause(err)
  const cause = describeCause(code, message)
  if (code && NEVER_CONNECTED_CODES.has(code)) {
    return new ApiError(0, `Could not reach ${baseUrl} (${cause})`)
  }
  return new ApiError(
    0,
    `The connection to ${baseUrl} was interrupted before a response arrived (${cause}). ` +
      `The service is likely up. A proxy, VPN, or unstable network can break ` +
      `requests mid-flight. Try again.`,
  )
}

const API_PREFIX = '/api/v1/lite'

/** How this client authenticates: a room key (data plane) or a user JWT (control plane). */
export type ClientAuth = { kind: 'apiKey'; key: string } | { kind: 'bearer'; token: string }

interface RequestInit_ {
  body?: string | FormData
  json?: unknown
  expectEmpty?: boolean
}

export class MageClient {
  private readonly auth: ClientAuth

  constructor(
    private readonly baseUrl: string,
    auth: ClientAuth | string,
  ) {
    // A bare string is an API key — keeps the common call sites terse.
    this.auth = typeof auth === 'string' ? { kind: 'apiKey', key: auth } : auth
  }

  private async request<T>(method: string, path: string, init: RequestInit_ = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(this.auth.kind === 'apiKey'
        ? { 'X-API-Key': this.auth.key }
        : { Authorization: `Bearer ${this.auth.token}` }),
      Accept: 'application/json',
    }
    let body = init.body
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, { method, headers, body })
    } catch (err) {
      throw toFetchApiError(this.baseUrl, err as Error)
    }

    if (!res.ok) throw await toApiError(res)
    if (init.expectEmpty || res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /** Resolve the calling key to its room — backs `mage login`. */
  getContext(): Promise<RoomContext> {
    return this.request<RoomContext>('GET', '/cli/context')
  }

  listDocuments(roomId: string): Promise<DocumentSummary[]> {
    return this.request<DocumentSummary[]>('GET', `/rooms/${roomId}/documents`)
  }

  /** Mint a short-lived presigned URL for a document's file bytes.

      Requires a key minted with the `room:download` permission — keys created
      before permissions existed (or minted without Download) get a 403 with
      `missing_permission` in the detail. Every mint lands on the room's
      access-audit trail server-side. */
  getDocumentUrl(roomId: string, documentId: string): Promise<DocumentUrl> {
    return this.request<DocumentUrl>(
      'GET',
      `/rooms/${roomId}/documents/${documentId}/url?download=true&intent=open`,
    )
  }

  uploadDocument(
    roomId: string,
    file: { filename: string; content: Uint8Array; contentType?: string; folderPath?: string | null },
  ): Promise<DocumentSummary> {
    const form = new FormData()
    const blob = new Blob([file.content], { type: file.contentType || 'application/octet-stream' })
    form.append('file', blob, file.filename)
    // The destination folder is a raw Form field (`folder_path`), not JSON — it
    // is not camelCased like the body endpoints below.
    if (file.folderPath) form.append('folder_path', file.folderPath)
    return this.request<DocumentSummary>('POST', `/rooms/${roomId}/documents`, { body: form })
  }

  // ── Direct-to-S3 multipart upload (the bytes never transit the API) ──────

  /** Begin a direct-to-S3 multipart upload; returns the full presigned plan. */
  initiateDocumentUpload(
    roomId: string,
    file: { filename: string; fileSize: number; contentType?: string },
  ): Promise<DocUploadPlan> {
    return this.request<DocUploadPlan>('POST', `/rooms/${roomId}/documents/initiate`, {
      json: {
        filename: file.filename,
        fileSize: file.fileSize,
        contentType: file.contentType || 'application/octet-stream',
      },
    })
  }

  /** Re-presign one part whose URL expired (or was missing) mid-upload. */
  signDocumentUploadPart(
    roomId: string,
    uploadId: string,
    partNumber: number,
  ): Promise<{ presignedUrl: string; expiresIn: number }> {
    return this.request<{ presignedUrl: string; expiresIn: number }>(
      'POST',
      `/rooms/${roomId}/documents/${uploadId}/sign-part`,
      { json: { partNumber } },
    )
  }

  /** Assemble the uploaded parts and create the room document. `fileHash` is
      the SHA-256 hex digest of the file, so content dedup works exactly as it
      does on the proxied path (where the server hashes the body itself). */
  completeDocumentUpload(
    roomId: string,
    uploadId: string,
    body: { parts: DocUploadPart[]; fileHash?: string; folderPath?: string | null },
  ): Promise<DocumentSummary> {
    return this.request<DocumentSummary>(
      'POST',
      `/rooms/${roomId}/documents/${uploadId}/complete`,
      { json: { parts: body.parts, fileHash: body.fileHash, folderPath: body.folderPath ?? null } },
    )
  }

  /** Mint a short-TTL presigned PUT so the caller can test direct-to-S3
      connectivity before committing to the multipart path. */
  getUploadProbe(roomId: string): Promise<UploadProbe> {
    return this.request<UploadProbe>('POST', `/rooms/${roomId}/documents/upload-probe`)
  }

  createFolder(roomId: string, folderPath: string): Promise<FolderSet> {
    return this.request<FolderSet>('POST', `/rooms/${roomId}/folders`, { json: { folderPath } })
  }

  deleteFolder(roomId: string, folderPath: string): Promise<FolderSet> {
    return this.request<FolderSet>('POST', `/rooms/${roomId}/folders/delete`, { json: { folderPath } })
  }

  deleteDocument(roomId: string, documentId: string): Promise<void> {
    return this.request<void>('DELETE', `/rooms/${roomId}/documents/${documentId}`, {
      expectEmpty: true,
    })
  }

  /** The room's readiness checklist — what's present, partial, and missing. */
  getCoverage(roomId: string): Promise<Coverage> {
    return this.request<Coverage>('GET', `/rooms/${roomId}/coverage`)
  }

  /**
   * Set the FULL set of documents attached to one checklist item (the server
   * diffs it against its own matches, so pass the merged set — existing
   * attachments plus additions). Returns the refreshed coverage.
   */
  setCoverageItem(roomId: string, itemId: string, documentIds: string[]): Promise<Coverage> {
    return this.request<Coverage>('PUT', `/rooms/${roomId}/coverage/items/${itemId}`, {
      json: { documentIds },
    })
  }

  // ── Control plane (bearer auth): the signed-in user, not a room key ──────

  /** The signed-in user; the first call also provisions their lite org. */
  getMe(): Promise<LiteMe> {
    return this.request<LiteMe>('GET', '/me')
  }

  /** Every room in the user's org — how OAuth login discovers what to bind to. */
  listRooms(): Promise<LiteRoom[]> {
    return this.request<LiteRoom[]>('GET', '/rooms')
  }

  /** Create a room in the user's org — the zero-room first-login path. */
  createRoom(name: string): Promise<LiteRoom> {
    return this.request<LiteRoom>('POST', '/rooms', { json: { name } })
  }

  /** Mint a room-scoped key (owner/admin only). The raw key is returned exactly once. */
  mintApiKey(roomId: string, name: string): Promise<MintedApiKey> {
    // Permissions are explicit (not the server default) so the CLI's contract
    // is visible here: read + download + organize, never room management.
    return this.request<MintedApiKey>('POST', `/rooms/${roomId}/api-keys`, {
      json: { name, permissions: ['room:view', 'room:download', 'room:edit'] },
    })
  }

  /** Revoke a key — how a re-login retires the key it replaces. */
  revokeApiKey(roomId: string, keyId: string): Promise<void> {
    return this.request<void>('POST', `/rooms/${roomId}/api-keys/${keyId}/revoke`, {
      expectEmpty: true,
    })
  }
}

/**
 * The deployment's public WorkOS client id — the OAuth bootstrap. Standalone
 * and UNauthenticated: it runs before any credential exists.
 */
export async function fetchAuthConfig(baseUrl: string): Promise<{ clientId: string }> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}${API_PREFIX}/cli/auth-config`, {
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    throw toFetchApiError(baseUrl, err as Error)
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as { clientId: string }
}

async function toApiError(res: Response): Promise<ApiError> {
  let detail = res.statusText || `HTTP ${res.status}`
  try {
    const data = (await res.json()) as { detail?: unknown }
    if (typeof data?.detail === 'string') detail = data.detail
    else if (data?.detail != null) detail = JSON.stringify(data.detail)
  } catch {
    // Non-JSON error body — keep the status text.
  }
  return new ApiError(res.status, detail)
}
