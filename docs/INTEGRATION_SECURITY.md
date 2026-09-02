# Integration Security

Credentials contain a UUID locator and 256 bits of random secret material. S2 NAS stores only the SHA-256 digest of that high-entropy secret and uses timing-safe comparison. The full key is returned once and is never written to activity metadata or returned by list/detail APIs.

Authentication checks format, digest, expiry, revocation, and app state. Failed attempts do not update `lastUsedAt`; successful authentication updates credential and app timestamps. Revocation and disablement are checked on every request.

Integration authentication is separate from browser cookies and human JWTs. Apps use dedicated SERVICE actors and never inherit human roles. Each endpoint requires an exact scope and walks resource ancestry to the configured root. Resource moves are not exposed.

Uploads reuse configured request limits, staging, file-signature/MIME checks, SHA-256 checksums, atomic commits, and compensating cleanup. Downloads pass through authorization; storage is not public. Backlinks accept only credential-free HTTP(S) URLs, and strict schemas reject spoofed or unexpected fields.

Audit events cover app, credential, and resource operations without secrets. Rotate a key by creating a replacement, updating the caller, verifying use, and revoking the old credential. Never put real keys in source control, screenshots, support tickets, shell history, or documentation.
