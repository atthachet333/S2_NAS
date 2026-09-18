# Link Lock — a share link locates a document, it never unlocks one

## 1. The global rule

**No anonymous request obtains document bytes, or any derivative of them.** That covers file content, previews, downloads, thumbnails, converted renditions, extracted or OCR text, historical versions, folder child listings, and search within a share.

Before this phase a public share link was simultaneously an address *and* a credential: whoever held the URL could open the document. A link forwarded into a group chat, quoted in a reply-all, or left in the history of a shared machine became a permanent key that only stopped working if somebody remembered to revoke it.

Now the link does one job — **it says which document you meant**. Authorisation comes from the signed-in user, through the gates that already existed.

**Authentication is necessary but not sufficient.** A public link never grants access the user does not already hold.

## 2. What was actually open

The audit found exactly five anonymous routes serving document bytes or metadata, all in `public-share.routes.ts`. Nothing else in the API served document data without a guard (`/health`, `/system/info`, `/system/storage` and the auth endpoints are infrastructure and carry no document data).

| Route | Was | Now |
|---|---|---|
| `GET /public/shares/:token` | filename, type, MIME, extension, size, link permissions, expiry — all anonymous | `requireLogin` → then the user's own rights |
| `POST /public/shares/:token/verify-password` | anonymous password attempts | `requireLogin` first |
| `GET /public/shares/:token/children` | **anonymous folder enumeration** | `requireLogin` → then per-user authorisation |
| `GET /public/shares/:token/content` | **anonymous file bytes** | `requireLogin` → authorisation → `allowPreview` |
| `GET /public/shares/:token/download` | **anonymous file bytes** | `requireLogin` → authorisation → `allowDownload` **and** the user's own download right |

The paths still begin with `/public` because thousands of already-distributed links must keep resolving. "Public" now means *anyone may forward this URL*, not *anyone may open this document*.

## 3. Error semantics

| Code | Status | Meaning | What the user should do |
|---|---|---|---|
| `LOGIN_REQUIRED` | 401 | not authenticated, or the session expired | sign in |
| `ACCESS_DENIED` | 403 | authenticated, but this account has no right to the document | contact an administrator |
| `PORTAL_RESOURCE_NOT_FOUND` / 404 | 404 | deliberately non-disclosing | nothing to do |

These are kept distinct server-side. Collapsing them tells half the users the wrong next step, and an expired session would look like a revoked permission.

**Anonymous callers are answered as generically as possible.** A valid token, an expired one, a revoked one and a forged one all return the identical `401 LOGIN_REQUIRED`. §4 of the brief allowed returning link state to the blocked page; that was deliberately *not* done, because an unauthenticated state oracle lets anyone test whether a guessed token is real — the same disclosure the guest routes have always refused. The blocked page needs no server data: its copy is static.

The guard also rejects before touching the database, so a bot spraying tokens costs no file reads, no provider calls and no folder walks.

## 4. Login redirect

```
/s/<token>  →  BLOCKED  →  เข้าสู่ระบบ  →  /login?returnTo=/s/<token>  →  back to /s/<token>
                                                      ↓
                                       authorised → document
                                       unauthorised → ACCESS DENIED
```

The return target is **never trusted as given**. `sanitizeReturnTo()` accepts only internal absolute paths: it fully decodes (catching `%252f` style nesting), rejects control characters and CR/LF, backslashes, `//` and `/\` protocol-relative forms, any `:` in the path portion, `..`, and over-long values — and it **never repairs** a suspicious value, because repairing produces destinations nobody intended. Anything that fails falls back to `/`.

## 5. Authorisation after login

The link is resolved to a resource, then the existing authorities decide:

- **Internal users** — `capabilities(resource, user)`. A public link does not let a colleague open something their `visibility` and grants do not already allow. (Note: an `ORGANIZATION`-visible document is already readable by internal staff with read permission — that is pre-existing `visibility` policy, not something the link confers.)
- **External users** — `resolvePortalAccess`, which already merges manual grants, the workflow overlay, lifecycle and the classification ceiling.

Link state is checked first and independently: **logging in never revives an expired or revoked link**, and the F25-D classification ceiling still closes a link even for the document's owner.

**Download is not implied by login.** A user who may preview but not download still cannot download through the link — the link's `allowDownload` and the user's own right must *both* be true. Otherwise Link Lock would become a privilege-escalation path instead of a gate.

## 6. Classification

`PUBLIC` no longer means "anonymous bytes allowed". It means governance permits a share entry point to exist. Document content still requires authentication in every case.

| Classification | Share link may exist | Anonymous content | Authenticated |
|---|---|---|---|
| `PUBLIC` | yes | **no** | normal authorisation |
| `INTERNAL` | no (link creation refused) | no | normal authorisation |
| `CONFIDENTIAL` / `RESTRICTED` | no | no | external channels stay closed |

## 7. Existing links

Nothing was deleted, rotated or rewritten. An old active link now shows BLOCKED to an anonymous visitor, opens for an authorised signed-in user, and denies an unauthorised one. Expired and revoked links stay that way.

## 8. Audit and rate limiting

**No new event type was added, deliberately.** Anonymous hits are refused before any database work, and logging them would let any crawler flood `ActivityLog` — the same reasoning that keeps the blocked-delete events limited to deliberate human attempts. Meaningful authenticated access continues to be audited exactly as before, and a test asserts no raw share token ever reaches the activity log. The existing per-IP rate limits remain (120/min general, 10/5min for password attempts, keyed per IP+token).

## 9. Deliberate backward-incompatible change

Anonymous access to shared content is gone. This is the point of the phase.

No existing backend test asserted anonymous HTTP success — the old behaviour was only exercised through the browser — so there were no "anonymous works" assertions to rewrite. One adjacent test in `portal-hardening` asserted that *a logged-in customer receives exactly what a guest receives*; that premise inverts under Link Lock, and it was **rewritten with an explanatory comment**, not deleted. It now asserts the property that still matters: a link grants a customer account nothing extra.

## 10. Known limitations and accepted gaps

1. **Real-browser QA not exercised.** The blocked page is verified structurally (copy, targets, safe areas, `dvh`, no hover-only actions, nothing about the document rendered) but has not been opened on a real device at 320–1024+.
2. **Offline behaviour on a share link is untested in a browser.** The app's existing connectivity handling applies; no share/login action is queued or replayed.
3. `X-Guest-Pass` link passwords remain as a second factor on top of login. They are now arguably redundant for most links, but removing them would weaken links whose owners deliberately set one.
4. The `/public/...` path prefix is now a slight misnomer, kept for compatibility with distributed links.
5. Rate limits are unchanged; no new abuse platform was built.
