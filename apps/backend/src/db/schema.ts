import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  index,
} from 'drizzle-orm/pg-core';

// Postgres holds application data only. Authorization (users, roles,
// permissions, sessions) lives in DynamoDB — see auth/users.ts and
// auth/roles.ts. Where an app-data row needs to identify a user, it
// carries a plain UUID `userId` matching DynamoDB's authUsersTable PK.
// No FK constraint here — the user-of-truth is in DDB, not Postgres.

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// File attachments for notes. Stored in the shared S3 bucket provisioned
// by hereya/aws-s3-shared; the row here records metadata + the canonical
// s3Key. Deletion of a note CASCADEs the rows here, but the S3 objects
// themselves are deleted separately by the route handler so we never
// leave orphan objects in the bucket.
//
// userId is denormalized off notes.user_id so the per-row authz check
// ("is this attachment mine?") doesn't need a Drizzle join — the routes
// can guard with a single WHERE.
export const noteAttachments = pgTable('note_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  noteId: uuid('note_id')
    .notNull()
    .references(() => notes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  filename: text('filename').notNull(),
  s3Key: text('s3_key').notNull().unique(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Static-only / public form example. No auth required to write a row.
export const newsletterSubscriptions = pgTable('newsletter_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// -----------------------------------------------------------------------
// OAuth 2.1 server state — backs the /oauth/* + /mcp routes (see
// docs/mcp.md). Public clients (PKCE-only, no client_secret) are the
// only flavor: MCP desktop apps connect via Dynamic Client Registration
// without a static secret.
// -----------------------------------------------------------------------

// Self-registered clients (DCR). `id` is the generated client_id we
// hand back at registration time; the client uses it for /authorize +
// /token. `redirectUris` is a JSON-encoded string[] — Postgres has a
// native array type, but text-encoded JSON keeps the schema portable.
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').notNull(),
  logoUri: text('logo_uri'),
  clientUri: text('client_uri'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Short-lived (~60 s) authorization codes. Single-use — `consumedAt`
// is stamped at /token exchange to prevent replay.
export const oauthAuthCodes = pgTable('oauth_auth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull(),
  scope: text('scope').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

// Active access + refresh tokens. Tokens themselves never persist —
// only SHA-256 hashes. `revokedAt` flips on explicit disconnect from
// the admin/integrations page.
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accessTokenHash: text('access_token_hash').notNull().unique(),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id').notNull(),
    scope: text('scope').notNull(),
    accessExpiresAt: timestamp('access_expires_at', {
      withTimezone: true,
    }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', {
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Used by the /admin/integrations page to list a user's active
    // connections + by the bearer-token middleware on every /mcp call
    // (via accessTokenHash unique constraint).
    userIdx: index('oauth_tokens_user_idx').on(t.userId),
  }),
);
