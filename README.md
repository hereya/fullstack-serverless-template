# Hereya Fullstack Serverless Template

> For agent-driven workflows (Claude Code etc.), start with **[CLAUDE.md](CLAUDE.md)**.

A starter monorepo demonstrating the Hereya serverless story:

- **Frontend:** Astro (static, multi-page) with Lit web-component islands for interactive components
- **Backend:** Hono on AWS Lambda with Aurora Data API (no VPC required) + Drizzle ORM
- **Auth:** Passwordless email-OTP via AWS Cognito Custom Auth Flow + Postmark
- **Hosting:** Single CloudFront distribution → API Gateway + S3 (one origin, no CORS)

## Architecture at a Glance

```
                ┌─────────────────────────┐
  Browser ────▶ │   CloudFront            │
                │   - /api/* → API Gateway│ ─▶ Lambda (Hono)
                │   - /*    → S3 (Astro)  │       │
                └─────────────────────────┘       │
                                                  ├─▶ Aurora Data API (Postgres)
                                                  ├─▶ Cognito User Pool
                                                  ├─▶ DynamoDB (sessions / OTP)
                                                  └─▶ Postmark (email)
```

## Packages used

This template lists four runtime packages and one dev-only package in `hereya.yaml`:

| Package                           | Provides                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `hereya/aws-postgres-serverless`  | Aurora Serverless v2 cluster, accessed via Data API                                       |
| `aws/cognito`                     | Cognito user pool + Lambda triggers for email-OTP + DDB tables for sessions, users, roles |
| `hereya/postmark-app-server`      | Postmark server + verified sender domain                                                  |
| `hereya/aws-file-storage`         | Prefix-scoped S3 access on top of the workspace's shared bucket                           |
| `hereya/dev-iam-user` (devDeploy) | IAM user creds for local dev with the same policies the Lambda gets                       |

And one deploy package:

| Package                 | Provides                                          |
| ----------------------- | ------------------------------------------------- |
| `hereya/aws-app-lambda` | Lambda + API Gateway + S3 + CloudFront + ACM cert |

## Local quickstart

```bash
# 1. Provision dev infra (Aurora, Cognito, Postmark, dev IAM user)
hereya up

# 2. Run DB migrations against the dev cluster (via Data API)
hereya run -- npm run db:migrate

# 3. Start the dev server
hereya run -- npm run dev
# Frontend: http://localhost:4321 | Backend: http://localhost:4000 (Astro proxies /api → :4000)
```

## Deploying

Deployment is **one pass in auto-Route 53 mode** (when the workspace
exposes a `defaultRootDomain` pointing at a hosted zone it owns) and
**three passes in external-DNS mode** (when the user owns the domain at
a registrar like Cloudflare / Namecheap and copies DNS records
manually). See [`docs/custom-domain.md`](docs/custom-domain.md) for the
details and the hereyavars settings that pick the mode.

After the cert is `ISSUED` and the aliases are attached, the app serves
at `https://<your-domain>`, `www → apex` is a 301 redirect, and OTP
email is sent from `auth@<your-domain>`.

## Tests

```bash
npm test           # both workspaces
npm test -w apps/backend
npm test -w apps/frontend
```

The backend `notes.test.ts` is `describe.skip(...)` by default — flip it on to run integration tests
against a real Aurora dev cluster.

## More

For the full topic-by-topic documentation (use cases, custom domains,
adding features, troubleshooting), start at
[`CLAUDE.md`](CLAUDE.md) and follow its decision tree.
