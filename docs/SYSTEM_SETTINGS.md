# SYSTEM SETTINGS (F4)

Runtime operational settings, editable at `/admin/settings` and backed by the existing `SystemSetting` model. No schema change and no migration were required.

## Resolution order

```
SystemSetting row  →  environment variable  →  hardcoded safe default
```

Environment support is never removed. Deleting an override returns the system to whatever that machine's environment provides, so a bad value set through the web can always be undone without editing the database.

`source` distinguishes all three: `DATABASE` (an override exists), `ENVIRONMENT` (the variable is set in `process.env`), `DEFAULT` (neither — the schema default applies).

## Supported keys

Strict allowlist. Anything not listed is rejected with `SETTING_KEY_UNKNOWN`.

| Key | Env fallback | Bounds | Effect |
| --- | --- | --- | --- |
| `TRASH_RETENTION_DAYS` | `S2_NAS_TRASH_RETENTION_DAYS` | 1–365 | immediate |
| `MAX_UPLOAD_SIZE_MB` | `MAX_UPLOAD_SIZE_MB` | 1–10240 | lowering immediate; raising needs restart |
| `ZIP_MAX_RESOURCES` | `S2_NAS_ZIP_MAX_RESOURCES` | 1–100000 | immediate |
| `ZIP_MAX_BYTES` | `S2_NAS_ZIP_MAX_BYTES` | 1–1 TiB | immediate |

`0` is not selectable for any key. Zero retention would mean "delete immediately", and a zero limit would disable the feature rather than bound it — both are footguns disguised as valid numbers.

`ZIP_MAX_BYTES` is capped at 1 TiB, far below `Number.MAX_SAFE_INTEGER`, so byte totals can be summed without overflow. Values beyond the safe-integer range are rejected rather than silently truncated.

### Not settings

`DATABASE_URL`, JWT and refresh secrets, integration credentials, database passwords, `S2_NAS_STORAGE_ROOT`, ports, and `CORS_ORIGIN` are **not** editable and must never be added. F4 covers operational values only — things that can be set wrong and still be recovered from without console access. Startup identity and secrets do not qualify.

## Permission

`system:settings:manage`, granted to `SUPER_ADMIN` only. `ADMIN` receives every permission except `roles:manage` and this one. The code follows the existing `namespace:verb` convention used by every other permission.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/settings` | effective values, sources, defaults, restart notes |
| `PATCH` | `/api/admin/settings` | partial update; all keys validated before any write |
| `DELETE` | `/api/admin/settings/:key` | remove an override and fall back |

A `PATCH` containing one invalid value writes nothing — the request is rejected before the transaction, so a partially applied state cannot occur. Errors: `SETTING_KEY_UNKNOWN`, `SETTING_VALUE_INVALID`, `SETTING_UPDATE_EMPTY`, `SETTING_NOT_OVERRIDDEN`.

## Runtime integration

Every consumer reads through `getSetting()`; no runtime code reads these values from `env` directly any more.

- **Trash retention** — `runTrashRetention()` reads the value on **every sweep**, not at startup, and the worker no longer decides at boot whether to run at all. A change therefore takes effect on the next sweep with no restart. `listTrash` derives both `expiresAt` and the reported `retentionDays` from the same call.
- **Upload size** — `stageUpload` already enforced a byte cap while streaming, so the effective value is simply passed to it. Enforcement stays server-side and happens before bytes reach disk. The transport caps (`bodyLimit`, multipart `limits.fileSize`) are bound at server start, so a **lower** value applies immediately while **raising** above the boot value requires a restart. The UI states this on the field rather than pretending otherwise.
- **ZIP limits** — resolved once per plan and threaded through the traversal, so the cap is enforced as the plan grows rather than only at the end.

## Cache

Resolved values are cached in-process and invalidated explicitly on every write — never by expiry, so a saved value is never briefly ignored. If the database cannot be read the service falls back to the environment and logs a warning, so a settings outage cannot break uploads or ZIP downloads. A value stored but no longer valid (for example after bounds are tightened) is skipped in favour of the environment, with a warning.

**Limitation:** the cache is per process. Running multiple backend processes would require cross-process invalidation.

## Audit

`SYSTEM_SETTING_UPDATED` and `SYSTEM_SETTING_RESET` record `key`, `oldValue`, and `newValue`. Only operational values are recorded — no secret can reach these rows because no secret is an editable key.

## Activation

```bash
npm run rbac:sync
```

Permission and role definitions live in `backend/prisma/rbac.ts`, and `syncRbac()` applies them. The script touches only `Permission`, `Role`, and `RolePermission` — it never reads or writes users, password hashes, account status, role assignments, or tokens. It is idempotent: every write is an upsert on a unique key, and a second run reports `Already up to date`.

`prisma/seed.ts` calls the same `syncRbac()` rather than keeping a second copy of the definitions, so the two paths cannot drift. Use `prisma:seed` only when you actually intend to seed users — it requires `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` and manages the admin account.

Sync only grants; it never revokes. Removing a permission from a role is a deliberate decision, not a side effect of running a sync.

## Not included

`DEFAULT_VIEW_MODE` was considered and **excluded**. View mode is a per-user browser preference held in `localStorage` (`useViewMode.ts`); there is no server-side user-preference plumbing today. Making it a server setting would mean either a new per-user preferences surface or forcing one global view on everyone — neither fits the existing architecture cleanly, which was the condition for including it.
