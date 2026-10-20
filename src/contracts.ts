/**
 * Shared contracts for the Redmine MCP server.
 *
 * Every module in this project builds against these types. Nothing here has a
 * runtime dependency on the MCP SDK, so tool modules stay testable in isolation.
 */

import type { z } from 'zod';

/** HTTP methods this server is willing to send to Redmine. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Details about the currently signed-in principal. */
export interface AccountInfo {
  login: string;
  firstname?: string;
  lastname?: string;
  mail?: string;
  /** Redmine user id. */
  id: number;
  admin?: boolean;
}

/**
 * Login-time snapshot of the signed-in identity, cached beside the token
 * cache so status output can name the session without a Redmine call.
 *
 * Stored as JSON encrypted with the same 32-byte key as the token blob, never
 * inside that blob: it must survive token-cache wipes and die with key
 * rotation. `capturedAt` is an ISO-8601 instant; `source` says whether the
 * snapshot came from the OAuth login or a `/users/current.json` call.
 */
export interface IdentityRecord {
  id: number;
  login: string;
  firstname?: string;
  lastname?: string;
  mail?: string;
  admin?: boolean;
  redmineUrl: string;
  capturedAt: string;
  source: 'oauth-login' | 'users-current';
}

/**
 * Acquires Redmine credentials (OAuth2 access tokens or an API key).
 *
 * Implementations cache tokens and refresh silently. `getToken` must never
 * block on interactive input once a session exists.
 */
export interface AuthProvider {
  /**
   * Returns the credential header value for a Redmine call.
   *
   * For OAuth sessions this is `Bearer <access-token>`; for API-key sessions
   * it is the raw key the client sends as `X-Redmine-API-Key`. Never opens a
   * browser; throws `InteractionRequiredError` when interaction is needed.
   */
  getCredential(scopes: string[]): Promise<{ scheme: 'bearer' | 'apiKey'; value: string }>;
  /** The signed-in account, or null when no session exists. */
  getAccount(): Promise<AccountInfo | null>;
  /**
   * Starts an interactive sign-in and resolves once a session exists.
   *
   * `flow` is normally omitted so the configured CLI flow is used. Callers
   * that expose a particular user experience, such as the browser-opening MCP
   * sign-in tool, may force that flow without changing the server-wide config.
   */
  login(scopes: string[], flow?: AuthFlow): Promise<AccountInfo>;
  /** Clears the cached session. */
  logout(): Promise<void>;
  /**
   * Starts an API-key sign-in for pre-6.1 servers (or servers whose admin
   * never enabled the OAuth provider): verifies the key with
   * `GET /users/current.json` and stores the encrypted binding.
   */
  loginWithApiKey(apiKey: string): Promise<AccountInfo>;
  /**
   * Probes whether the stored session can still mint credentials, without
   * needing interaction and without disturbing the cached account. Status
   * only — never a credential, and never throws for an unusable session.
   */
  sessionHealth?(scopes?: string[]): Promise<SessionHealth>;
}

/**
 * Whether the stored session can still be refreshed.
 *
 * `credentialUsable` answers the question; `note` says why not (or what was
 * not checked) in one line a status report can quote. Never carries a secret.
 */
export interface SessionHealth {
  credentialUsable: boolean;
  note?: string | undefined;
}

/** Raised when credentials cannot be acquired without user interaction. */
export class InteractionRequiredError extends Error {
  override readonly name = 'InteractionRequiredError';
  /**
   * Scopes among those requested that the Redmine application was not
   * granted. Present when signing in again cannot fix the failure, so the
   * caller can say so instead of sending the user round a loop that will not
   * terminate.
   */
  readonly missingScopes: readonly string[];
  /**
   * True when the Redmine server itself refuses OAuth (no provider, REST API
   * disabled). Signing in again fails identically; the message names the
   * server-side fix instead.
   */
  readonly serverRefused: boolean;
  /**
   * True when the request never reached Redmine (DNS, proxy, TLS, offline).
   * Signing in again changes nothing while the network is down; retrying the
   * call once it is back is the fix.
   */
  readonly networkFailure: boolean;
  /**
   * True when the browser flow's loopback redirect could not be served and
   * timed out. Retrying needs a free loopback port rather than another blind
   * browser attempt.
   */
  readonly loopbackTimeout: boolean;
  /**
   * The scopes the failed call asked for, so a headline can echo them back in
   * paste-ready form instead of gesturing at "the scopes the detail names".
   * Empty when the raiser did not record them; headlines then stay generic.
   */
  readonly scopes: readonly string[];
  constructor(
    message: string,
    missingScopes: readonly string[] = [],
    serverRefused = false,
    networkFailure = false,
    loopbackTimeout = false,
    scopes: readonly string[] = [],
  ) {
    super(message);
    this.missingScopes = missingScopes;
    this.serverRefused = serverRefused;
    this.networkFailure = networkFailure;
    this.loopbackTimeout = loopbackTimeout;
    this.scopes = scopes;
  }
}

/**
 * Which interactive sign-in flow `login` uses.
 *
 * - `browser` — OAuth2 authorization code with PKCE (RFC 7636) against a
 *   loopback redirect. Opens the system browser and catches the redirect on
 *   127.0.0.1. Best experience, but needs Redmine 6.1+, a desktop session,
 *   and a free port.
 * - `apikey`  — paste an API key (works on every Redmine with REST enabled).
 *   Used from the terminal, or automatically when the server has no OAuth
 *   provider.
 * - `auto`    — try `browser`, fall back to `apikey` guidance when there is
 *   no browser, no loopback port, or no OAuth provider. The default.
 */
export type AuthFlow = 'auto' | 'browser' | 'apikey';

// ---------------------------------------------------------------------------
// Redmine client
// ---------------------------------------------------------------------------

/** A single Redmine request. */
export interface RedmineRequestOptions {
  /** Redmine-relative path beginning with `/`, e.g. `/issues.json`. */
  path: string;
  method?: HttpMethod;
  /** Query parameters. `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Redmine permission scopes required for this call. */
  scopes: string[];
  /**
   * How many pages of a collection to follow via `offset`/`limit`.
   * Defaults to 1, meaning no automatic paging.
   */
  maxPages?: number;
  signal?: AbortSignal;
}

/** The outcome of a Redmine request. */
export interface RedmineResponse<T = unknown> {
  status: number;
  data: T;
  /** Total collection size, when Redmine reports `total_count`. */
  totalCount?: number;
}

/** A raw (possibly binary) Redmine response. */
export interface RedmineRawResponse {
  status: number;
  bytes: Uint8Array;
  contentType: string;
}

/** Talks to Redmine with retry, paging, and host pinning. */
export interface RedmineClient {
  request<T = unknown>(opts: RedmineRequestOptions): Promise<RedmineResponse<T>>;
  /**
   * Sends `body` verbatim and returns the raw bytes. Used for uploads
   * (`POST /uploads.json`) and attachment downloads. Same host pinning and
   * credential handling as `request`; no paging, no JSON parsing.
   */
  requestRaw(opts: RedmineRequestOptions & { body?: Uint8Array; contentType?: string }): Promise<RedmineRawResponse>;
}

/** A Redmine error surfaced to the caller. */
export class RedmineError extends Error {
  override readonly name = 'RedmineError';
  readonly status: number;
  readonly path: string;
  readonly hint: string | undefined;

  constructor(init: {
    message: string;
    status: number;
    path: string;
    hint?: string | undefined;
  }) {
    super(init.message);
    this.status = init.status;
    this.path = init.path;
    this.hint = init.hint;
  }
}

// ---------------------------------------------------------------------------
// Tool layer
// ---------------------------------------------------------------------------

/** Metadata describing a logical group of tools and what it needs consent for. */
export interface ToolGroupMeta {
  /** Stable identifier used by `--groups` and `--preset`, e.g. `issues`. */
  name: string;
  title: string;
  description: string;
  /** Redmine permission scopes the group's read tools need. */
  readScopes: string[];
  /** Extra permission scopes the group's write tools need. */
  writeScopes: string[];
  /**
   * True when the group needs Redmine administrator rights.
   * Groups flagged here are excluded unless `--org-mode` is set.
   */
  requiresAdmin: boolean;
}

/** A single callable tool, independent of how it gets registered. */
export interface ToolDefinition {
  /** Wire name, e.g. `issues_list`. Lowercase with underscores. */
  name: string;
  title: string;
  /** Shown to the model. State what it returns and any important limits. */
  description: string;
  /** Must be a `z.object({...})`. */
  inputSchema: z.ZodType;
  /** True when the tool mutates data. Suppressed under `--read-only`. */
  write?: boolean;
  /**
   * Opt-in identity attribution: when true, the registration layer prepends a
   * one-line rendering of the login-time cached identity to this tool's
   * serialized output. Defaults to off; an absent snapshot means no line,
   * never an error.
   */
  includeIdentity?: boolean;
  /** Redmine permission scopes this specific tool needs. */
  scopes: string[];
  /** The group this tool belongs to, for discovery and filtering. */
  group: string;
  /**
   * Runs the tool. Return any JSON-serialisable value; the registration layer
   * serialises and truncates it. Throw `RedmineError` for Redmine failures.
   */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Everything a tool module needs to build its definitions. */
export interface ToolDeps {
  redmine: RedmineClient;
  config: ServerConfig;
  /**
   * Required, not optional. The sign-in tools live in the generic module and are
   * the only way to authenticate from inside a conversation; if this were
   * optional, forgetting to pass it would remove them silently and the install
   * would look fine until someone tried to sign in.
   */
  auth: AuthProvider;
  /**
   * Every scope this configuration may ask consent for, including the extras
   * individual tools declare beyond their group's meta.
   *
   * A function rather than a value because the catalogue is what it is computed
   * from, and the catalogue is what this object is being passed to build.
   */
  consentScopes: () => string[];
}

/** One domain area of Redmine, e.g. issues or projects. */
export interface ToolModule {
  group: ToolGroupMeta;
  build(deps: ToolDeps): ToolDefinition[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Serialisation used for tool result text.
 *
 * - `json` — indented JSON. The default.
 * - `toon` — compact TOON-style tables: headers once plus bare rows.
 */
export type OutputFormat = 'json' | 'toon';

/** Fully resolved runtime configuration. */
export interface ServerConfig {
  /** Redmine base URL, e.g. `https://redmine.example.com`. No trailing slash. */
  redmineUrl: string;
  /** OAuth2 application (client) ID registered in Redmine. */
  clientId: string;
  /**
   * OAuth2 application secret. Redmine/Doorkeeper applications are
   * confidential, so the token exchange sends this alongside the PKCE
   * verifier. Empty while unset.
   */
  clientSecret: string;
  /**
   * API key from `--api-key` or `REDMINE_MCP_API_KEY`. Empty while unset.
   *
   * When set, tools use it directly with zero login steps: it wins over any
   * stored OAuth session (explicit configuration beats cache). The value is
   * never written to disk, never printed, and never returned by a tool — it
   * only travels in the `X-Redmine-API-Key` request header.
   */
  apiKey: string;
  /** Names of the enabled tool groups. */
  groups: string[];
  /**
   * Requested groups dropped for needing admin rights while orgMode
   * is off. Optional so existing configs stay valid.
   */
  droppedGroups?: string[];
  /** Suppress every write tool. */
  readOnly: boolean;
  /** Expose `discover_tools`/`call_tool` instead of every domain tool. */
  discovery: boolean;
  /** Enable groups that require Redmine administrator rights. */
  orgMode: boolean;
  /** Hard cap on serialised tool output, in characters. */
  maxOutputChars: number;
  /** Serialisation used for tool result text. */
  output: OutputFormat;
  /** Log Redmine requests to stderr. */
  verbose: boolean;
  /** Directory holding the encrypted token cache. */
  cacheDir: string;
  /** Which interactive sign-in flow `login` uses. */
  authFlow: AuthFlow;
  /**
   * Fixed loopback port for the browser flow's redirect URI, or 0 to let the OS
   * pick. Set this when the Redmine application registers an exact
   * `http://127.0.0.1:PORT/callback` redirect.
   */
  authPort: number;
  /** Expose the generic `redmine_request` write escape hatch. */
  allowGenericWrite: boolean;
}
