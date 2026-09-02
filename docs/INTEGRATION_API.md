# Integration API

All endpoints are under `/api/integrations`. Send the one-time credential as `Authorization: Bearer s2nas_<credential-id>_<secret>`. Examples use placeholders only.

Scopes are `resources:read`, `resources:create`, `resources:upload`, `resources:update`, `resources:download`, and `resources:metadata`. Every operation also enforces the app's allowed-folder ancestry.

## Create metadata

`POST /api/integrations/resources`

```json
{
  "type": "WEB_LINK",
  "name": "Payroll Run 2026-09-001",
  "parentId": "<folder-id>",
  "externalUrl": "https://example.test/document",
  "sourceEntityType": "PAYROLL_RUN",
  "sourceEntityId": "2026-09-001",
  "sourceUrl": "https://payroll.example.test/runs/2026-09-001"
}
```

Supported metadata types are `FOLDER`, `WEB_LINK`, `GOOGLE_SHEET`, `GOOGLE_DOC`, and `GOOGLE_DRIVE`. Unknown fields, including client-supplied `sourceType`, are rejected.

## Files and versions

`POST /api/integrations/resources/upload` accepts multipart `file`, `parentId`, and optional `remark`, `sourceEntityType`, `sourceEntityId`, and `sourceUrl`. It reuses the browser pipeline for size limits, staging, MIME inspection, checksums, atomic storage, and versions.

`POST /api/integrations/resources/:id/versions` accepts multipart `file` and optional `remark`. It explicitly creates a version; existing bytes are never silently replaced.

## Read and update

- `GET /api/integrations/resources?parentId=<folder-id>` lists direct children.
- `GET /api/integrations/resources/:id` returns safe metadata.
- `GET /api/integrations/resources/:id/metadata` returns safe metadata with the dedicated `resources:metadata` scope.
- `PATCH /api/integrations/resources/:id` updates name, remark, or a supported external URL.
- `GET /api/integrations/resources/:id/download` securely streams content with `resources:download`.

Responses never expose `storageKey`, a physical path, or a credential hash.

## Retry contract

Send `Idempotency-Key` (maximum 191 characters) on create or upload. Repeating the same app, key, and logical input returns the original resource. Different input returns `INTEGRATION_IDEMPOTENCY_CONFLICT` (409). Keys are isolated per app. Use the explicit version endpoint when bytes must change.

Stable errors include `INTEGRATION_AUTH_FAILED`, `INTEGRATION_CREDENTIAL_REVOKED`, `INTEGRATION_DISABLED`, `INTEGRATION_SCOPE_DENIED`, `INTEGRATION_PERMISSION_DENIED`, and `INTEGRATION_IDEMPOTENCY_CONFLICT`. Integration endpoints have a dedicated 120 requests/minute limit and reuse `S2_NAS_MAX_UPLOAD_BYTES`.
