# EXTERNAL RESOURCES

Phase F2 stores Google Sheet, Google Doc, Google Drive, and ordinary web links as normal `Resource` rows. The S2 NAS `Resource.id` remains the identity used by hierarchy, ownership, search, tags, favorites, pins, sharing, lock, activity, and trash.

## URL-only model

- `type` identifies `GOOGLE_SHEET`, `GOOGLE_DOC`, `GOOGLE_DRIVE`, or `WEB_LINK`.
- `externalUrl` stores a normalized HTTP(S) URL.
- `externalProvider` is assigned by the server as `GOOGLE_SHEETS`, `GOOGLE_DOCS`, `GOOGLE_DRIVE`, or `WEB`.
- Google resources use `sourceType=GOOGLE`; generic web links use `sourceType=MANUAL`.
- There is no storage key, checksum, physical file, downloaded Google content, or server-side preview.

The server parses and validates the URL locally. It does not fetch metadata, crawl content, resolve redirects, perform DNS resolution, or make any outbound URL request. This avoids an SSRF surface in F2.

## Validation

Only HTTP and HTTPS are accepted. `javascript:`, `data:`, `file:`, FTP, credentials embedded in URLs, and other schemes are rejected. Google types must match their expected host and path:

- Sheet: `docs.google.com/spreadsheets/...`
- Doc: `docs.google.com/document/...`
- Drive: `drive.google.com/...`

The same validator is applied when the URL is edited. Provider and source are never accepted as arbitrary client input.

## Access boundary

S2 NAS permissions determine whether a user can discover, view, edit, share, lock, or trash the Resource record inside S2 NAS. They do not grant access to the underlying Google item. Google independently decides whether the signed-in Google account can open it.

## Opening links

External resources open in a new tab with `noopener,noreferrer`. URLs are rendered as text/attributes, never injected as HTML. Generic web links are labeled as external links.

## Future Google integration

OAuth, connected apps, Google API reads, sync metadata, and remote content search are intentionally outside F2. A future phase can attach provider IDs and sync state without replacing `Resource.id` or changing the hierarchy.
