# Pattern: WebAuthn (passkeys) alongside email OTP

Use this when users want one-click sign-in. Passkey auth runs as a
**second** sign-in method alongside the existing email/OTP flow — OTP
stays in place as the fallback and the first-user-bootstrap path. A
user first signs in via OTP, registers a passkey from Settings, then
uses the passkey button on the login page from then on.

## What this changes

- Two new public DDB row kinds (`WACRED#` durable credentials, `WACHAL#`
  short-lived challenges) on the **existing** `aws-ddb-app-state` table.
  No new package, no new infra.
- Backend: `/api/webauthn/*` routes + a store module + small edits to
  `auth/sessions.ts` and `middleware/auth.ts`.
- Frontend: passkey button on `/login`, a Passkeys card on a new
  `/admin/settings` page, an invite banner on every admin page until
  the user registers their first device.

## Critical security/UX properties

- Both sign-in methods produce **identical session cookies** — every
  downstream check (admin gate, MCP, permission middleware) sees one
  shape and doesn't care which method authenticated the user.
- Passkey-initiated sessions have `refreshToken: null`. The
  authMiddleware skips the Cognito token refresh on that branch and
  serves the identity directly from the session-row snapshot.
- The signature counter is checked on every assertion — a regression
  (newCounter ≤ stored) is rejected as a likely cloned authenticator.
- The authenticate endpoints pad to a minimum response time so the
  "unknown email" branch is indistinguishable from the happy path,
  preventing user-enumeration via timing.
- Discoverable credentials by default: no email required to sign in,
  the OS picks the right passkey. An email hint is supported for the
  rare cases where the user wants to nudge the selection.

## Storage model — single-table reuse

Two discriminator prefixes on the OAuth state table
(`oauthStateTableName`):

```
WACRED#<credentialIdB64Url>   durable. userId + createdAt indexed
                              by the existing byUser-index GSI for
                              "list this user's passkeys".
WACHAL#<challengeIdB64Url>    short-lived (5 min). Single-use:
                              consumed via DeleteCommand on the
                              register/authenticate verify step.
```

**Critical gotcha:** auth-kind challenge rows must NOT write
`userId: null`. The byUser-index expects `userId` to be a string; the
literal NULL type throws `Type mismatch for Index Key userId` at
PutItem time. Omit the attribute entirely (sparse-index semantics).
The store's `createChallenge` does this already — don't shortcut it.

## Dependencies

```jsonc
// apps/backend/package.json
"dependencies": {
  "@simplewebauthn/server": "^13.0.0",
  // …existing
}

// apps/frontend/package.json
"dependencies": {
  "@simplewebauthn/browser": "^13.0.0",
  // …existing
}
```

## Backend

### 1. Sessions — make `refreshToken` nullable

In `apps/backend/src/auth/sessions.ts`:

```ts
export interface Session {
  sessionId: string;
  userId: string;
  email: string;
  roleName: string;
  // null on passkey-initiated sessions (no Cognito round-trip
  // happened). authMiddleware skips the access-token refresh on null
  // and serves the identity directly from the session-row snapshot.
  refreshToken: string | null;
  ttl: number;
}

export async function createSession(
  userId: string,
  email: string,
  roleName: string,
  refreshToken: string | null,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  // Omit `refreshToken` entirely when null — staying out of the
  // attribute keeps reads symmetric with what we wrote.
  const item: Record<string, unknown> = {
    sessionId,
    userId,
    email,
    roleName,
    createdAt: new Date().toISOString(),
    ttl: now + SESSION_TTL_SECONDS,
  };
  if (refreshToken) item.refreshToken = refreshToken;
  await doc().send(
    new PutCommand({ TableName: tableName(), Item: item }),
  );
  return sessionId;
}
```

And in `getSession`, hydrate `refreshToken` as `string | null`:

```ts
refreshToken: (r.Item.refreshToken as string | undefined) ?? null,
```

### 2. Middleware — skip refresh on passkey sessions

In `apps/backend/src/middleware/auth.ts`, wrap the existing
refresh/decode block in `if (session.refreshToken) { … }`. Passkey
sessions fall through with `sub = null`:

```ts
let sub: string | null = null;
if (session.refreshToken) {
  let cached = accessTokenCache.get(sessionId);
  if (!cached || isExpired(cached)) {
    try {
      const { accessToken, expiresIn } = await refreshTokens(
        session.refreshToken,
      );
      cached = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
      accessTokenCache.set(sessionId, cached);
    } catch {
      await clear(c, sessionId);
      return c.json({ error: 'unauthenticated' }, 401);
    }
  }
  try {
    const decoded = jwtDecode<{ sub: string }>(cached.accessToken);
    if (decoded.sub) sub = decoded.sub;
  } catch {
    // fall through with null
  }
}
```

Downstream code that wants the canonical user id should read
`c.get('user').id` (= session.userId), not `sub`. The only consumers
that need `sub` are the OAuth/MCP token surfaces — those use bearer
tokens directly and don't go through this middleware.

### 3. WebAuthn store

Add `apps/backend/src/auth/webauthnStore.ts` — see the file shipped
with this template for the canonical implementation. It exposes:

```
createChallenge(opts)           // returns { challengeId }
consumeChallenge(id, kind)      // single-use atomic delete
registerCredential(c)           // PutItem with attribute_not_exists
getCredential(credentialId)
listCredentialsByUser(userId)   // QueryCommand on byUser-index, filter WACRED#
updateCredentialCounter(id, n)  // UpdateCommand, sets lastUsedAt
revokeCredential(id, userId)    // owner-scoped delete, returns bool
```

Three load-bearing details to keep:

1. `createChallenge` omits `userId` and `email` attributes when null,
   to satisfy the byUser-index `userId: string` schema.
2. `consumeChallenge` uses `DeleteCommand` with `ReturnValues: 'ALL_OLD'`
   so the verify step gets the challenge bytes back in one round-trip.
3. `listCredentialsByUser` filters on `begins_with(pk, "WACRED#")` so
   the GSI doesn't return any OAuth `TOKEN#` rows that also have
   `userId` set.

### 4. Routes

Add `apps/backend/src/routes/webauthn.ts` — see the shipped file. The
endpoint layout:

| Path | Auth | Purpose |
|---|---|---|
| `POST /api/webauthn/register/options`     | session  | Issue registration options + persist `register` challenge |
| `POST /api/webauthn/register/verify`      | session  | Verify attestation, persist `WACRED#` row |
| `POST /api/webauthn/authenticate/options` | none     | Issue auth options + persist `auth` challenge (discoverable by default; email hint optional) |
| `POST /api/webauthn/authenticate/verify`  | none     | Verify assertion, mint session, return Set-Cookie |
| `GET /api/webauthn/credentials`           | session  | List the authed user's passkeys |
| `DELETE /api/webauthn/credentials/:id`    | session  | Owner-scoped revoke |

Three details to keep:

- `RP_NAME` is the friendly name shown in the OS prompt. Default in
  the template is `'hereya-app'` — every project should rename this
  to their product name. It does NOT need to match `rpID`.
- `rpConfig()` derives `rpID` (hostname) from `process.env.appUrl`
  first (prod), then the `Origin` header (dev). Changing the domain
  invalidates existing credentials by design.
- The authenticate endpoints `pad()` every response to
  `RESPONSE_MIN_MS` so the unknown-email branch is timing-
  indistinguishable. Test env disables padding (`NODE_ENV === 'test'`).
- Passkey verify calls `createSession(user.id, user.email,
  user.roleName, null)` — the null refreshToken is the load-bearing
  flag for the middleware change above.

### 5. Mount in `app.ts`

```ts
import { webauthn } from './routes/webauthn.js';

app.route('/api/webauthn', webauthn);  // mixed: register/* + credentials* authed, authenticate/* anonymous
```

### 6. Tests

Add `apps/backend/tests/webauthn.test.ts` — mirrors `auth.test.ts`'s
mocking pattern. Mocks `@simplewebauthn/server` so tests don't
construct real cryptographic payloads. Covers:

- `register/options` returns 401 unauthed
- `register/options` (authed) persists a register-kind challenge
- `register/verify` happy path stores the credential
- `register/verify` rejects stale challenge + verified=false
- `authenticate/options` empty allowCredentials when no email
- `authenticate/options` populated allowCredentials when email given
- `authenticate/verify` happy path creates a session with
  `refreshToken: null`
- `authenticate/verify` rejects unknown credential + counter regression
  + suspended user
- `GET /credentials` returns the user's list
- `DELETE /credentials/:id` honors owner scoping (404 on mismatch)

See the shipped test file for the exact mock shape — copy verbatim.

## Frontend

### 7. Shared library

Add `apps/frontend/src/lib/passkey.ts`. Three exports:

```ts
export async function registerPasskey(deviceLabel: string): Promise<
  | { status: 'ok' }
  | { status: 'cancelled' }    // user dismissed OS prompt
>;

export function defaultDeviceLabel(): string;  // sniffs navigator.userAgent

export const PASSKEY_ICON_PATHS: readonly string[];  // shared fingerprint icon
```

Centralizing the registration roundtrip means the Settings card and
the post-login banner can't drift on field names or order.

### 8. Settings card — `<hy-passkeys>`

Add `apps/frontend/src/components/Passkeys.ts`. Light-DOM Lit element
that:

- On mount: `GET /api/webauthn/credentials` → render list
- "Register this device" form with auto-detected label
- Per-row Remove button

### 9. Invite banner — `<hy-passkey-banner>`

Add `apps/frontend/src/components/PasskeyBanner.ts`. Same registration
flow as the settings card, but only renders when:

- `browserSupportsWebAuthn()` is true
- The user has zero registered passkeys
- The banner hasn't been dismissed (localStorage key
  `hereya_passkey_invite_dismissed_v1`)

**Lit/SVG gotcha:** when building inline icons with
`.map(d => html\`<path d=${d}/>\`)`, the `<path>` elements get created
in the HTML namespace and silently don't render (zero bounding box).
Use Lit's `svg` tagged template instead of `html` for the nested
fragments:

```ts
import { svg } from 'lit';

${PASSKEY_ICON_PATHS.map((d) => svg`<path d=${d}></path>`)}
```

This is documented inline in the shipped `PasskeyBanner.ts` — preserve
the comment.

### 10. Login page — passkey button + finishSignIn helper

Edit `apps/frontend/src/components/LoginForm.ts`:

1. Add imports:
   ```ts
   import {
     browserSupportsWebAuthn,
     startAuthentication,
   } from '@simplewebauthn/browser';
   import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
   ```
2. Add two new `@state` fields: `passkeyBusy = false` and
   `passkeySupported = false`.
3. In `firstUpdated()`, set `this.passkeySupported =
   browserSupportsWebAuthn();`.
4. Factor out the post-auth tail into a `finishSignIn()` method (so
   the OTP path and the passkey path can't drift):
   ```ts
   private finishSignIn(): void {
     clearAuthCache();
     bumpAuthSync();
     window.location.href = getNextPath('/admin/users');
   }
   ```
   …and call it from `verifyOtp()` in place of the existing three
   lines + redirect.
5. Add a `signInWithPasskey()` method — see the shipped file for the
   full body. Three steps: POST `/authenticate/options`, call
   `startAuthentication`, POST `/authenticate/verify`. **Swallow
   `NotAllowedError` silently** so the OTP form is still usable when
   the user dismisses the OS prompt.
6. In the `step === 'email'` branch of `render()`, prepend the
   passkey button + divider (gated on `this.passkeySupported`) above
   the existing email form. Switch the email input's autocomplete to
   `"email webauthn"` so the OS can suggest a passkey from the email
   field directly.

### 11. Settings page + admin tab

Add the `Settings` tab to `apps/frontend/src/components/AdminTabs.ts`:

```ts
type Tab = 'users' | 'registrations' | 'integrations' | 'settings';

const tabs = [
  // …existing…
  { key: 'settings', href: '/admin/settings', label: 'Settings' },
];
```

Add a new page `apps/frontend/src/pages/admin/settings.astro`:

```astro
---
import AdminBase from '../../layouts/AdminBase.astro';
import { HyAdminTabs } from '../../components/AdminTabs';
import { HyPasskeys } from '../../components/Passkeys';
import { HyPasskeyBanner } from '../../components/PasskeyBanner';
---
<AdminBase title="Admin · Settings">
  <div class="space-y-1">
    <h1>Settings</h1>
    <p class="text-sm text-neutral-500">
      Your account · sign-in methods and devices
    </p>
  </div>
  <HyAdminTabs current="settings" client:only="lit" />
  <HyPasskeyBanner client:only="lit" />
  <HyPasskeys client:only="lit" />
</AdminBase>
```

### 12. Banner on every admin page

Add `<HyPasskeyBanner client:only="lit" />` between `<HyAdminTabs>`
and the page's main island in each of:

- `apps/frontend/src/pages/admin/users.astro`
- `apps/frontend/src/pages/admin/registrations.astro`
- `apps/frontend/src/pages/admin/integrations.astro`

(Settings already has it from step 11.) The banner self-hides on
browsers without WebAuthn, when the user has at least one passkey, or
when dismissed.

## Verification

```bash
# Type check + tests for both workspaces
npm run typecheck -w apps/backend
npm test -w apps/backend       # webauthn.test.ts adds ~14 cases
npm test -w apps/frontend

# Astro build catches SSR / import errors in the new components
npm run build -w apps/frontend

# End-to-end smoke (manual, after `hereya run -- npm run dev`):
#   1. Sign in via email/OTP
#   2. /admin/settings → "Register this device"
#   3. OS prompts for Touch ID / passkey; approve
#   4. Sign out
#   5. /login → "Sign in with passkey" button → OS prompts, approves
#   6. Lands on /admin/users
```

## Why no new infra

The `oauthStateTableName` DDB table already has the right shape:

- `pk` partition key (any string discriminator works)
- TTL attribute named `ttl` (Unix seconds) — auto-prunes the 5-min
  `WACHAL#` challenge rows
- `byUser-index` GSI (`userId` PK, `createdAt` SK) — list-by-user is a
  single Query, no new GSI required

The shared IAM policy emitted by `hereya/aws-ddb-app-state` already
grants the app Lambda role `GetItem / PutItem / UpdateItem /
DeleteItem / Query` on the table + indexes. Nothing in
`hereya.yaml` changes.

## Limits + escape hatches

- **One credential per user per device** — `excludeCredentials` is
  populated on register/options so the OS refuses to overwrite an
  existing passkey on the same authenticator. To rotate, delete the
  old credential first.
- **Domain changes invalidate passkeys.** rpID = the eTLD+1 the user
  registered against. Moving from `app.example.com` to
  `app.example.io` bricks every existing credential. Set the production
  domain before users start registering.
- **Cross-device flow not built-in.** The shipped UI supports
  same-device passkeys only. WebAuthn's cross-device "scan QR code"
  flow works browser-side automatically, but the UX for that lives
  outside this pattern.
- **No backup/recovery beyond the platform's own sync.** Apple/Google
  passkeys sync via their respective keychains. A user who loses
  every device with their passkey can still fall back to the email
  OTP flow — which is why we keep OTP in place.
