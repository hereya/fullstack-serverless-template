# Custom domain

Everything here is **`hereyaconfig/hereyavars/*.yaml` edits**. Neither
`hereya.yaml` nor any package code is touched.

Two parameter files matter:

- `hereyaconfig/hereyavars/hereya--aws-app-lambda.yaml`
  — controls the CloudFront/ACM/Route 53 alias side
- `hereyaconfig/hereyavars/hereya--postmark-app-server.yaml`
  — controls the Postmark sender-domain side

They cooperate via the `effectiveDomain` env var: postmark's package
publishes which domain it ended up using; aws-app-lambda's package
reads it back so CloudFront serves and Postmark sends from the same
hostname.

Three modes. Pick one for the user's situation.

---

## Mode A — Auto-Route 53 (recommended)

**When**: the workspace exposes a `defaultRootDomain` env var (e.g.
`example.com`) pointing at a Route 53 hosted zone the workspace owns.
This is the path that produces zero manual DNS work.

**Never pin `subdomainName` in this mode.** The agent doesn't set it
even if the user asks. Postmark's `random_pet` generates a
collision-safe label (e.g. `keen-otter`) keyed on `defaultRootDomain`,
stable across applies. That uniqueness guarantee is the whole point of
auto-Route 53 mode — pinning a chosen name would risk colliding with
other apps under the same root domain and defeat the design.

If the user wants a specific hostname they choose freely (e.g.
`myapp.example.com` or `example.com` at the apex), that's Mode B —
they supply the exact `domain` and own the DNS records.

`hereyaconfig/hereyavars/hereya--aws-app-lambda.yaml`:

```yaml
# Leave `domain` empty — the lambda package reads `effectiveDomain`
# from the workspace env (populated by postmark below) and uses it
# for the CloudFront aliases + ACM cert.
domain: ""
```

`hereyaconfig/hereyavars/hereya--postmark-app-server.yaml`:

```yaml
# Same: leave `domain` empty. With `defaultRootDomain` available, the
# package auto-creates DKIM TXT + return-path CNAME records in the
# hosted zone and emits `effectiveDomain` (= `<random-sub>.<defaultRootDomain>`)
# for downstream packages.
domain: ""
provisionDomain: true
```

That's it — no `subdomainName` line in either file.

**Deploy is one pass.** The provisioner:

1. Generates (or honors the pinned) subdomain
2. Creates `postmark_domain` in Postmark and writes DKIM + return-path
   records into Route 53
3. Calls Postmark's `verifyDkim` / `verifyReturnPath` endpoints to
   trigger immediate authoritative DNS lookup (sub-30 s on the happy
   path)
4. Issues a `DnsValidatedCertificate` in us-east-1, validates it against
   Route 53
5. Attaches `<sub>.<root>` + `www.<sub>.<root>` ALIAS records to the
   CloudFront distribution

The two packages converge on the same `effectiveDomain` so Postmark
sends from `auth@<sub>.<root>` and CloudFront serves at
`https://<sub>.<root>`.

---

## Mode B — External DNS

**When**: the user owns the domain at a registrar like Cloudflare,
Namecheap, GoDaddy, etc. — and is willing to copy DNS records once.

`hereyaconfig/hereyavars/hereya--aws-app-lambda.yaml`:

```yaml
domain: "app.example.com"
```

`hereyaconfig/hereyavars/hereya--postmark-app-server.yaml`:

```yaml
domain: "app.example.com"
provisionDomain: true
```

**Deploy is two passes.**

1. **First pass** — provisioning emits CFn outputs:
   - `dnsRecordCertValidationApex*` (CNAME for ACM)
   - `dnsRecordCertValidationWww*` (CNAME for ACM)
   - `dnsRecordDkimHost` / `dnsRecordDkimValue` (TXT for Postmark)
   - `dnsRecordReturnPathHost` / `dnsRecordReturnPathValue` (CNAME for
     Postmark)
   - `dnsRecordCloudfrontApex*` / `dnsRecordCloudfrontWww*` (CNAME to
     the CloudFront distribution)

   The CloudFront distribution comes up immediately on its default
   `*.cloudfront.net` cert (the custom-domain aliases stay off until
   the cert is `ISSUED`). Tell the user to copy all six records to
   their DNS provider.

2. **Second pass** — once the records are live and ACM has validated
   the cert (DNS propagation + ACM's poll cadence; usually a few
   minutes), redeploy. Two things happen in this one pass:
   - The `aws-app-lambda` package's synth reads the cert's live
     status from ACM (`aws acm list-certificates` keyed on the
     domain name, then narrowed to the cert carrying this stack's
     `hereya:stackName` tag) and, on seeing `ISSUED`, attaches the
     apex + www aliases plus the ACM cert to the CloudFront
     distribution.
   - The `postmark-app-server` package's apply fires
     `PUT /domains/<id>/verifyDkim` and `verifyReturnPath` directly
     against Postmark's API, forcing an immediate authoritative DNS
     lookup on Postmark's side instead of waiting ~5 minutes for
     Postmark's own poll cycle. Idempotent — Postmark returns
     "already verified" once done; subsequent applies are no-ops.

After pass two: `https://app.example.com` is live, Postmark sends from
`auth@app.example.com`.

> **Why the lookup is tag-scoped, not just by-domain.** Earlier
> `0.5.x` builds queried `aws acm list-certificates` by domain name
> only. This broke when an unrelated ACM cert for the same hostname
> already existed in the account — e.g. a stale cert left behind by a
> previously hand-rolled CloudFront. The stale cert satisfied the
> by-domain lookup as `ISSUED`, so the stack marked aliases enabled
> and wired its own freshly-requested PENDING cert into the
> Distribution; CloudFront rejected the pending cert with a 400 and
> rolled the stack back before any DNS-record outputs were ever
> emitted. As of `0.5.3` the package tags every cert it owns with
> `hereya:stackName=<stackName>` (via a dedicated `TagCertCr` custom
> resource that runs after `RequestCertCr`) and the synth-time
> lookup filters by that tag, so unrelated certs in the account are
> invisible to the gate.
>
> **Upgrading from `<0.5.3` is transparent.** Existing deploys' certs
> are untagged, but `RequestCertCr`'s inputs (domain, SANs,
> IdempotencyToken) are byte-identical to <0.5.3 — so CFn does not
> fire its Update event and ACM does not re-issue the cert. The new
> `TagCertCr` resource Creates on the first 0.5.3 deploy and tags
> the existing cert. On that one deploy the synth-time lookup hits a
> fallback path: it queries CloudFormation for the stack's prior
> `certificateArn` output, uses that ARN's live Status, and the
> Distribution's aliases stay attached for the whole upgrade.
> Subsequent deploys use the by-tag fast path directly.

---

## Mode C — No custom domain (CloudFront URL only)

**When**: dev / staging where the auto-generated `dXXXX.cloudfront.net`
URL is acceptable.

`hereyaconfig/hereyavars/hereya--aws-app-lambda.yaml`:

```yaml
domain: ""
# Leave subdomainName / defaultRootDomain alone — without a root
# domain, no cert work happens.
```

`hereyaconfig/hereyavars/hereya--postmark-app-server.yaml`:

```yaml
# Either disable domain provisioning entirely:
provisionDomain: false
# …or keep a pinned domain just so OTP emails go from a sane address.
```

CloudFront serves on the auto-generated URL only. No ACM cert, no
Route 53 records. **Postmark will refuse to send mail without a
verified sender domain** — if the app relies on OTP login, you need at
least a verified domain somewhere; use Mode A or B.

---

## When you change domain mode

Changing `domain` triggers a destroy + create of `postmark_domain`
(forced via the `terraform_data.domain_trigger` in the package). The
DKIM key rotates; if you're in Mode B the user has to update the new
DKIM TXT at their DNS provider. In Mode A this happens automatically.
