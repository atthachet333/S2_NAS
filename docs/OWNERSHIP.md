# OWNERSHIP

S2 NAS is an organization-owned file system. Uploader and responsible owner are intentionally different facts:

- `createdById` / `ResourceVersion.createdById`: immutable historical actor who uploaded the resource or version.
- `ownerId`: current person responsible for the resource. Files uploaded into a folder inherit the folder owner.

Changing a folder owner updates responsibility and emits `RESOURCE_OWNER_CHANGED`. It does not change `Resource.id`, child IDs, version IDs/history, checksums, uploader records, storage keys, physical files, or the access policy. Authorization continues to be derived from roles, visibility, ownership, and direct access—not from who happened to upload the bytes.

Only the current owner, an admin, or a user with `resources:owner:manage` may transfer folder ownership, and the new owner must be active.

Bulk handover moves every resource owned by one user to another in a single transaction, changing `ownerId` only, and emits `OWNERSHIP_BULK_TRANSFERRED`. Disabling an account that still owns resources is refused with `USER_STILL_OWNS_RESOURCES` unless explicitly acknowledged. See [HANDOVER.md](HANDOVER.md).
