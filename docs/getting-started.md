# Getting started — post-deploy walkthrough

Read this when the user says "help me get set up" (or similar) right
after a successful `hereya deploy`. Walk them through it; don't paste
the doc verbatim — translate into specific instructions for *their*
session.

The full sequence:

1. Open the deployed app URL.
2. Sign in. First sign-in claims admin.
3. Connect Claude Desktop (or another MCP client) to `/mcp`.
4. Smoke-test with a tool call.

---

## 1. Open the app URL

`hereya deploy` printed an `appUrl` output. If you're walking the user
through, ask them for the URL — it's typically something like
`https://<projectname>.hereya.ai` (or a custom domain if they wired one).

```bash
# If you have the project locally and want to confirm the URL:
hereya status | grep appUrl
```

Open it in a browser. The landing page should load — that confirms
CloudFront + S3 are serving the static frontend.

---

## 2. Sign in (first user becomes admin)

Click **Login** in the nav (or navigate to `/login`).

1. **Enter their email.** Use the address they actually want as the
   permanent admin — first sign-in is the bootstrap, and it doesn't
   easily un-claim.
2. **Receive the 6-digit OTP** via Postmark email. If it doesn't
   arrive:
   - Check spam.
   - Check the Postmark dashboard for the domain (the `postmark-app-server`
     package provisions it). If the domain isn't verified yet,
     Postmark won't deliver. Verification kicks off automatically on
     each deploy via the package's `verifyDkim` / `verifyReturnPath`
     calls; on a brand-new project it can take several minutes the
     first time. If the user just deployed, give it a few minutes
     before troubleshooting deeper.
   - Check CloudWatch logs for the Lambda — the OTP-request handler
     logs the email send attempt.
3. **Enter the code** on the verify screen. On success they land on
   `/admin/users` — they're admin now. The `__bootstrap__` sentinel
   in DDB's `authUsersTable` is now set; subsequent sign-ins go through
   the normal allowlist flow.

Confirm by looking at `/admin/users` — there should be exactly one
user row, with role `admin`.

---

## 3. Connect Claude Desktop to the MCP server

The app exposes an MCP server at `<app-url>/mcp` with OAuth 2.1 auth
(DCR + PKCE). Claude Desktop walks the flow automatically once you
point it at the URL.

1. **Open Claude Desktop's MCP settings.** In recent versions: Settings
   → Developer → Edit Config. The config file is at
   `~/Library/Application Support/Claude/claude_desktop_config.json`
   on macOS.
2. **Add an entry** for this server:
   ```json
   {
     "mcpServers": {
       "<project-name>": {
         "url": "https://<app-url>/mcp"
       }
     }
   }
   ```
   Replace `<project-name>` with whatever the user wants the server
   labelled as in Claude, and `<app-url>` with the actual URL from
   step 1.
3. **Restart Claude Desktop.** On reconnect, Claude Desktop fetches
   `/mcp`, gets back a 401 with a `WWW-Authenticate` header pointing
   at the OAuth resource metadata, then runs:
   - Dynamic Client Registration (`POST /oauth/register`)
   - Authorization (`GET /oauth/authorize` in a browser window)
   - Consent: the user lands on `/connect` and approves
   - Token exchange (`POST /oauth/token`)
4. **The browser tab closes itself.** Back in Claude, the server now
   shows up as connected.

---

## 4. Smoke test

In a Claude session, ask:

> List the users on my admin app.

Claude should call the `users_list` MCP tool and return the single
admin user from step 2. That confirms:

- The OAuth/MCP path works end-to-end.
- The Lambda's `byUser-index` query on `OAuthStateTable` resolves the
  bearer token.
- The admin-only permission check passed (admin role has every
  permission).

Other handy first-session prompts:

> Show me how many registrations we have.    ← calls `stats_summary`
> Register foo@example.com for me.           ← calls `registrations_add`
> Make bob@example.com an admin user.        ← calls `users_add`

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Landing loads but `/login` shows a blank page | Static cache lag (rare) | Wait 60s, hard refresh |
| OTP email never arrives | Postmark domain not yet verified | Wait several minutes; redeploy if still failing — Postmark verifyDkim runs on every Mode-B deploy |
| First sign-in returns "closed signup" | Race: another browser tab claimed admin first | Check `/admin/users` for the existing admin; have them add this email |
| Claude Desktop says "OAuth failed" | Cold-start delay on /me | Retry; if it still fails after 30s, check CloudWatch logs |
| `users_list` returns empty | Bearer middleware revoked / expired | Disconnect the MCP server in Claude and reconnect to re-run the OAuth flow |

---

## What's NOT covered here

- **Adding features** beyond the minimal template (notes, attachments,
  custom registration fields, billing, etc.). See the pattern catalogue
  in [`CLAUDE.md`](../CLAUDE.md#adding-a-feature-pattern-catalogue).
- **Custom domain wiring.** See [`docs/custom-domain.md`](custom-domain.md).
- **Deeper architecture.** See [`docs/architecture.md`](architecture.md).
