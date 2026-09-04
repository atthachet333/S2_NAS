# USER MANAGEMENT

`/admin/users` manages real `User`, `Role`, and `Permission` rows. No schema change was required for Phase F1.

## Status

The four statuses come from the existing `UserStatus` enum; none were invented.

| Status | Thai label | Meaning |
| --- | --- | --- |
| `ACTIVE` | เปิดใช้งาน | Can sign in and receive shares |
| `INVITED` | รอเปิดใช้งาน | Exists but has no password yet; cannot sign in |
| `SUSPENDED` | ระงับชั่วคราว | Temporarily blocked |
| `DISABLED` | ปิดใช้งาน | Blocked; cannot receive new shares |

Only `ACTIVE` users can be granted resource access (`SHARE_TARGET_INACTIVE`) or receive a handover (`HANDOVER_TARGET_INACTIVE`).

## INVITED → ACTIVE

`POST /api/users/:id/activate` with `temporaryPassword`:

1. the password is checked against the shared policy
2. it is hashed with bcrypt (12 rounds) and only the hash is stored
3. `status` becomes `ACTIVE` and `mustChangePassword` becomes `true`
4. `tokenVersion` is incremented and existing refresh tokens are revoked
5. `USER_ACTIVATED` is written to the activity log

The admin types the password; the system does not generate one. A generated password has to be displayed or transmitted somewhere, and that display is the easiest place for it to leak. Because `mustChangePassword` is forced, the temporary password survives exactly one sign-in.

The password is never returned in a response, never logged, and there is no endpoint that reads it back. After the dialog is submitted it is gone — the admin must pass it to the account holder through a secure channel at that moment.

## Temporary password policy

Shared by admin-set passwords and self-service changes, so the admin path can never be the weaker one:

- at least 12 characters, at most 200
- at least two character classes (lower, upper, digit, symbol)
- no leading or trailing whitespace
- not a single repeated character
- guessable tokens (`s2nas`, `password`, `qwerty`, long digit runs, `admin`) are stripped, and what remains must still be at least 12 characters

The last rule is deliberately not a blanket substring ban: a long, genuinely strong passphrase may happen to contain the word "password", and rejecting it would push admins toward worse choices.

## Password reset

`POST /api/users/:id/reset-password` re-hashes, sets `mustChangePassword`, bumps `tokenVersion`, and revokes refresh tokens. Without revoking sessions a reset would not actually cut off access, which is usually the reason it is being done.

## Disable protection

`POST /api/users/:id/disable` refuses an `ACTIVE` account that still owns resources, returning `USER_STILL_OWNS_RESOURCES` (409) with `{ ownedTotal, ownedFolders, ownedFiles }`. The UI shows **ผู้ใช้นี้ยังเป็นผู้ดูแลทรัพยากรอยู่** and offers **ไปที่การส่งมอบความรับผิดชอบ**, which navigates to the existing handover page rather than duplicating that flow.

Passing `acknowledgeHandover: true` proceeds anyway — the check is a warning, not a prohibition — but the choice is then explicit and recorded. See [HANDOVER.md](HANDOVER.md).

An admin cannot disable their own account (`CANNOT_DISABLE_SELF`).

## Last SUPER_ADMIN protection

The system must always keep at least one `ACTIVE` user holding `SUPER_ADMIN`. Both removing the role and deactivating the account are checked, inside the same transaction as the change, and rejected with `LAST_SUPER_ADMIN` (409).

Without this guard, one mis-click leaves nobody able to administer roles, and recovery requires editing the database by hand.

## Roles

`PATCH /api/users/:id/roles` accepts only role codes that exist in the database; unknown codes return `ROLE_NOT_FOUND`. Roles are never created ad hoc from the UI. A role change bumps `tokenVersion`, because the permissions embedded in the existing access token no longer match the account.

## Listing

`GET /api/users` supports `q` (name or email), `status`, `roleCode`, and `limit`/`cursor` pagination, returning `{ items, nextCursor, total }`. The page loads 25 rows at a time rather than the whole organization.

`passwordHash` is not part of the select and never leaves the server.

## Audit events

`USER_ACTIVATED`, `USER_DISABLED`, `USER_ROLE_CHANGED`, `USER_TEMP_PASSWORD_RESET`, plus the existing `CREATE_USER` / `UPDATE_USER`. Metadata carries the target user id and the resulting state only — never a password, hash, or token.

## First login

An activated user signs in with the temporary password, is forced to change it, and that change revokes every refresh token and bumps `tokenVersion`, so the temporary password and any session created with it stop working immediately.

## Account types (F10)

`UserType` is `INTERNAL | EXTERNAL | SERVICE`. The value `HUMAN` was renamed to `INTERNAL` in the F10 migration, in three steps (widen the enum, move the rows, narrow the enum) — a direct `MODIFY` to the new value set would have silently blanked every row.

Account type outranks roles everywhere. `requireInternal` rejects an `EXTERNAL` account before any internal module logic runs, and `capabilities()` returns an all-false set for it as a last line of defence. An external account that somehow acquires a broad internal role still cannot reach internal data.

`organizationName` holds a client's company name. It is a label for the administration screen, not a permission boundary — two clients at the same company still see only what was shared with each of them. Internal accounts never carry one.

Client accounts are created by an administrator at /admin/clients with no roles at all: a client's access comes from per-resource sharing, and giving a client an internal role would not grant anything real (external policy closes it) while making the user list misleading. There is no self-signup, and Google sign-in never creates an account. See [CLIENT_PORTAL.md](CLIENT_PORTAL.md).

`GET /api/users` accepts `type` so the internal and client screens share one endpoint without mixing the two lists.
