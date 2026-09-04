# SHARING

## Google and external resources

`ResourceAccess` governs visibility and management of the link record inside S2 NAS. It does not alter Google-side permissions. A user who can see a Google resource in S2 NAS may still be denied by Google, and this is expected in F2.

Sharing in S2 NAS is internal only. There are no public links, no external upload links, and no anonymous access. Every grant is bound to a real user account.

## Grant model

`ResourceAccess` holds one row per (resource, user):

- `accessLevel`: `EDITOR` or `VIEWER`. `OWNER` is never assigned through sharing — primary responsibility moves through owner transfer or handover instead.
- `allowDownload`: an explicit per-user download decision.

An explicit grant always outranks the organization default. A `VIEWER` with `allowDownload: false` can preview but not download, even when the folder is `ORGANIZATION`, because per-person restriction is the deliberate intent.

## Who may administer access

`canShare` is granted to admins, the resource's primary owner, and users holding `resources:share`. A delegated `EDITOR` does **not** inherit access administration — editing content and deciding who may see it are different kinds of authority.

Grants may only target `ACTIVE` users. Sharing to an invited, suspended, or disabled account returns `SHARE_TARGET_INACTIVE`. Targeting the owner returns `SHARE_INVALID_TARGET` (they already hold full rights).

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/resources/:id/access` | Requires `canView`; returns owner, visibility, `canManage`, and grants |
| `POST` | `/api/resources/:id/access` | Requires `canShare`; upserts a grant |
| `DELETE` | `/api/resources/:id/access/:userId` | Requires `canShare` |
| `GET` | `/api/shared` | Resources shared with the caller |
| `GET` | `/api/share-targets?q=` | Active users only, excludes self, returns id/name/email |

## /shared semantics

`/shared` lists **only** resources reached through an explicit `ResourceAccess` grant. Organization-visible resources are deliberately excluded; including them would turn the page into a list of everything in the company and make it meaningless.

## Auditing and privacy

`RESOURCE_ACCESS_GRANTED` and `RESOURCE_ACCESS_REVOKED` record `targetUserId`, access level, and download flag. Email addresses are never written into activity metadata.

A resource that cannot be viewed returns `RESOURCE_NOT_FOUND`, not `403`, so existence cannot be probed.

## Account status is part of the sharing contract

A grant can only target an `ACTIVE` account. An `INVITED` account has no password and cannot sign in, so a grant to it would be an access rule nobody can exercise — and one that quietly becomes live the day the account is activated. Activate first, then share. See [USER_MANAGEMENT.md](USER_MANAGEMENT.md).

Existing grants held by an account that is later disabled are kept and shown in the access list marked ปิดใช้งาน, so they can be cleaned up deliberately rather than disappearing silently.

## Sharing with external users (F10)

A grant can target an `EXTERNAL` account — a client — as well as an internal colleague. The share dialog separates the two groups (บุคลากรภายใน / ลูกค้า ผู้ใช้งานภายนอก) and labels every external account ภายนอก, because picking the wrong group means opening a document to someone outside the company. Defaulting to the narrowest level (ดูอย่างเดียว) when an external account is picked is deliberate for the same reason.

`SERVICE` accounts cannot be share targets at all. An integration gets its reach from its own configured scope, not from a grant.

External grants are audited as `EXTERNAL_ACCESS_GRANTED` / `EXTERNAL_ACCESS_REVOKED`, separate from the internal codes, so "which documents were opened to outsiders" is answerable straight from the log.

What a client can actually do with a grant is decided by external policy, never by the level name. See [CLIENT_PORTAL.md](CLIENT_PORTAL.md).

## Grant expiry

`ResourceAccess.expiresAt` (`null` = never) stores an absolute instant. The UI translates 7 / 30 / 90 days or a custom date into a real timestamp before sending; the server never stores "a number of days", because the reference point becomes ambiguous the moment the grant is edited later. The cap is 730 days — meaning to grant forever must be stated as ไม่หมดอายุ, not disguised as a very distant date.

Every permission check compares against the current time, so an expired grant is refused immediately with the existing token, and `/shared` drops it on the next request. The row stays in the database for audit; the access list shows it as หมดอายุแล้ว so an administrator can see it was once given.

Revocation is immediate for the same reason: permissions are never cached in the access token.
