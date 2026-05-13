# Pattern: richer registration form (custom fields)

The minimal template ships a public registration form that captures
email + optional name. Use this pattern when the project needs more —
event-specific fields (date, session preference), B2B fields (company,
job title), marketing fields (referrer, UTM tags), or anything else.

Because `RegistrationsTable` is schema-less, this pattern is mostly a
frontend change. The backend already accepts arbitrary extra fields
via `.passthrough()` on the Zod schema and stores them as-is.

## What the minimal template gives you

- **Frontend**: `apps/frontend/src/components/Registration.ts` —
  two-field form (name + email). Posts to `/api/registration`.
- **Backend**: `apps/backend/src/routes/registration.ts` — Zod schema
  with `.passthrough()`. Extra fields land in the DDB item alongside
  email + createdAt.
- **Store**: `apps/backend/src/auth/registrationsStore.ts` — DDB
  reads/writes; the `Registration` interface uses an index signature
  so extra fields are tolerated everywhere.
- **Admin**: `apps/frontend/src/components/AdminRegistrations.ts` —
  table shows Name + Email + Registered timestamp. Extra fields aren't
  rendered by default; see step 4 below for how to surface them.

## Steps

### 1. Add the new field(s) to the Lit form

In `src/components/Registration.ts`, add new `@state` properties and
input fields. Example: add a `company` field.

```ts
@state() private company = '';

// In render():
<div>
  <label for="reg-company" class="label">Company</label>
  <input
    id="reg-company"
    type="text"
    .value=${this.company}
    @input=${(e: Event) => (this.company = (e.target as HTMLInputElement).value)}
    placeholder="Acme Inc"
    class="input"
  />
</div>

// In submit():
const body: Record<string, unknown> = { email: this.email };
if (this.name.trim()) body.name = this.name.trim();
if (this.company.trim()) body.company = this.company.trim();
await api('/api/registration', { method: 'POST', body: JSON.stringify(body) });
```

That's it for the happy path — the field flows through the backend
`passthrough()` schema and lands on the DDB row.

### 2. (Optional) Tighten backend validation

If you want server-side validation on the new field (e.g. company must
be ≤ 200 chars), extend the schema in
`apps/backend/src/routes/registration.ts`:

```ts
const schema = z
  .object({
    email: z.string().email(),
    name: z.string().max(200).optional(),
    company: z.string().max(200).optional(),
  })
  .passthrough();
```

The `.passthrough()` is still there — it just means "any OTHER unknown
fields also pass." The named fields get type-checked.

### 3. (Optional) Project-specific TypeScript shape

If you want type-safety in the admin UI for the new field, narrow the
`Registration` interface in
`apps/frontend/src/components/AdminRegistrations.ts`:

```ts
interface Registration {
  email: string;
  createdAt: string;
  name?: string;
  company?: string;       // ← new
  [extra: string]: unknown;
}
```

### 4. Surface the new field on the admin page

In `AdminRegistrations.ts`, add a column to the table:

```ts
// In <thead>:
<th class="px-4 py-2 font-medium">Company</th>

// In each row:
<td class="px-4 py-2 text-neutral-500">
  ${r.company ?? html`<span class="text-neutral-400">—</span>`}
</td>
```

### 5. (Optional) Export / aggregate

For event registrations you often want a CSV export or "count by
company" aggregate. Two paths:

- **Quick**: an admin MCP tool that does an extra Scan + groupBy. Add
  to `src/mcp/handlers/registrations.ts`:
  ```ts
  export async function countByField(field: string): Promise<Record<string, number>>;
  ```
- **Heavier**: if the project will run thousands of these, add a GSI
  on the new field in `aws-ddb-app-state` (requires a version bump of
  that package — see its CLAUDE.md for the convention).

## What to think about

- **PII scope.** Each new field adds a place sensitive data lives. If
  you're capturing phone numbers / addresses, think about retention
  and admin access policies.
- **Honeypot.** The minimal template doesn't ship a honeypot field by
  default. If the form is publicly indexed and getting bot traffic,
  add one — mirror the LoginForm.ts honeypot pattern (offscreen field
  + server-side `website` check).
- **Required vs optional.** Default to optional for soft demographic
  fields. A drop-off study on event registration forms shows every
  required field above 3 reduces conversion noticeably.
- **Confirm-email flow.** Out of scope of this pattern. If a project
  needs to verify email ownership (not just capture it), use the OTP
  pattern from `routes/auth.ts` as a model — different flow, different
  store.
