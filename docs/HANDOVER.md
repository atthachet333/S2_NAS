# HANDOVER

Resources belong to the organization, not to individuals. When someone leaves or changes role, the files stay and must acquire a new responsible owner.

## What transfers

Bulk handover updates `ownerId` only. `createdById` and `ResourceVersion.createdById` are historical facts and are never rewritten — the record of who uploaded a document must survive a personnel change. IDs, storage keys, checksums, visibility, existing grants, and locks are all untouched.

The whole transfer runs in a single transaction. A half-completed handover across thousands of resources would be very hard to reconcile afterwards.

## Flow

1. `GET /api/handover/overview` — per-user counts (`ownedTotal`, `ownedFolders`, `ownedFiles`) plus `needsHandover`, true when an inactive account still owns resources.
2. `GET /api/handover/preview?fromUserId=&toUserId=` — read-only. Returns the exact total plus up to 50 sample items, with locked items marked.
3. `POST /api/handover/transfer` — performs the move and logs `OWNERSHIP_BULK_TRANSFERRED` with `{ fromUserId, toUserId, count }`. No email addresses are stored in the log.

The recipient must be `ACTIVE` (`HANDOVER_TARGET_INACTIVE`) and different from the source (`HANDOVER_SAME_USER`). Moving responsibility to another dormant account would just relocate the problem.

Authorization requires admin status or `resources:owner:manage`.

## Offboarding protection

`GET /api/users/:id/offboarding-check` reports what a user still holds, including how many resources they have locked.

`PATCH /api/users/:id` refuses to move an `ACTIVE` account to any inactive status while it still owns resources, returning `USER_STILL_OWNS_RESOURCES` (409) with `{ ownedTotal, ownedFolders, ownedFiles }`. It is a warning, not a prohibition: passing `acknowledgeHandover: true` proceeds deliberately. Silently disabling the account would leave documents owned by someone who can no longer sign in, with no record that anyone noticed.

## Entry points

Handover is implemented once, on `/admin/ownership`. The user row on `/admin/users` links to it (การส่งมอบความรับผิดชอบ) and the blocked-disable dialog offers the same link, rather than duplicating the transfer flow in a second place.
