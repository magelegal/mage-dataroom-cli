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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'ApiError'
  }
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
      // Network / DNS / TLS failure — never reached the API.
      throw new ApiError(0, `Could not reach ${this.baseUrl} (${(err as Error).message})`)
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
    throw new ApiError(0, `Could not reach ${baseUrl} (${(err as Error).message})`)
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
