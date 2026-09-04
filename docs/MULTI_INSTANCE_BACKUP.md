# MULTI-INSTANCE BACKUP SAFETY

F6 shipped with a per-process lock and said so plainly: two backend instances would each believe they were free and could back up simultaneously, producing packages that do not match their own manifests. F7 closes that with a database-backed lock.

## Two layers

| Layer | Scope | Purpose |
| --- | --- | --- |
| In-process mutex (`operation-lock.ts`) | one process | fast local rejection, no round trip |
| **MariaDB advisory lock (`distributed-lock.ts`)** | **all instances** | **the authoritative guard** |

The local mutex is kept because it answers same-machine collisions instantly, but it is never trusted alone — other processes cannot see it.

## The lock

One well-known name: `s2_nas_backup_operation`, taken with `GET_LOCK(name, timeout)` and released with `RELEASE_LOCK(name)`.

`GET_LOCK` returns `1` on success, `0` on timeout, and `NULL` on error. **Both `0` and `NULL` are treated as failure** — reading `NULL` as success would let two instances proceed at once.

## Connection semantics — the critical detail

MariaDB advisory locks belong to a **connection**, not to an application session. If `GET_LOCK` and `RELEASE_LOCK` land on different pooled connections, the release silently does nothing and the lock stays held until the original connection closes. Backups would then stop happening, quietly.

The implementation therefore uses a **dedicated `PrismaClient` with `connection_limit=1`**, separate from the application pool. A pool of exactly one guarantees every lock statement runs on the same connection.

Release always happens in `finally`; `withDistributedLock` guarantees it even when the work throws. Releasing twice is a no-op and cannot release someone else's lock — both are tested.

## Crash safety

If a process dies, its connection closes and **MariaDB releases the advisory lock automatically**. No stale lock survives a crash, and no janitor process is needed. This is verified by a test that disconnects a client without calling `RELEASE_LOCK` and then acquires from another instance.

## Conflict matrix

All long-running backup and restore operations take the same lock, so they are mutually exclusive across every instance:

| | Backup | Retention | Restore stage | Rehearsal | Offsite copy |
| --- | --- | --- | --- | --- | --- |
| **Backup** | ✕ | ✕ | ✕ | ✕ | ✓ |
| **Retention** | ✕ | ✕ | ✕ | ✕ | ✓ |
| **Restore stage** | ✕ | ✕ | ✕ | ✕ | ✓ |
| **Rehearsal** | ✕ | ✕ | ✕ | ✕ | ✓ |
| **Offsite copy** | ✓ | ✓ | ✓ | ✓ | ✓ |

✕ = mutually exclusive · ✓ = may run concurrently

**Why offsite copying is excluded.** It only *reads* a completed backup package and writes to a different destination; it never mutates the package, the database, or storage. Blocking it behind the same lock would mean a long copy to a slow network share delays the nightly backup — a cost with no safety benefit. Its own state machine (`offsiteState`, bounded attempts) prevents overlapping copies of the same backup.

Read-only operations — listing, verification, status — take no lock at all.

## Timeout

`S2_NAS_BACKUP_LOCK_TIMEOUT_SECONDS` (default 10, max 60). On timeout the request fails with `BACKUP_OPERATION_BUSY` (409) rather than queueing. Indefinite waiting is worse than a clear refusal: users retry, work piles up invisibly, and nobody can tell what is happening.

## Remaining limitation

The settings cache is still per process. A schedule change made on one instance is not seen by another until that instance's cache is invalidated. This affects *when* an instance thinks a backup is due, not whether two can run at once — the lock covers that.
