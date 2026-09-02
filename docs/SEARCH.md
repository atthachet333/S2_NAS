# SEARCH

`GET /api/search` searches the whole workspace and returns only what the caller may see.

## Permission filtering happens first

The visibility predicate is part of the SQL `WHERE` clause, not a post-filter:

- admins: unrestricted
- everyone else: `visibility = ORGANIZATION` OR `ownerId = me` OR an explicit `ResourceAccess` row

Filtering after the query would leak the existence of restricted documents through result counts and through pages that look broken after filtering. Results are additionally re-checked with `capabilities().canView` before serialization, so a future divergence between the two paths fails closed.

`total` is computed with the same scoped `WHERE`, so the count a user sees always matches the rows they can reach.

## Parameters

| Param | Meaning |
| --- | --- |
| `q` | Matches normalized name (case-insensitive, NFC) or remark text |
| `type` | `FOLDER` / `FILE` / `GOOGLE_SHEET` / `GOOGLE_DOC` / `GOOGLE_DRIVE` / `WEB_LINK` |
| `sourceType` | `MANUAL`, `GOOGLE`, `S2_PAYROLL`, `S2_ERP`, `S2_LINE_BOT`, `EXTERNAL_UPLOAD`, `SYSTEM` |
| `ownerId` | Responsible owner |
| `tagId` | Tag membership |
| `visibility` | `ORGANIZATION` / `RESTRICTED` |
| `updatedFrom`, `updatedTo` | Modified-date range |
| `favoriteOnly` | Caller's own favorites |
| `limit`, `cursor` | Pagination (folders first, then most recently modified) |

External resources are searched by their local S2 NAS name, remark, and tags. F2 never reads or searches remote Google/web content.
`storageKey` and physical paths are never searchable and never returned.

## Facets

`GET /api/search/facets` returns owners and tags that appear on resources the caller can actually see, with counts. Building the filter list from all data would make the filter panel itself an information leak.

## UI

The header combobox debounces at 250 ms, supports `/` to focus, arrow/Home/End navigation, Enter to open, Escape to dismiss, and offers "see all results". Selecting a file navigates to its parent folder with `?focus=<id>`, which selects the file and opens the details panel — a file has no page of its own, and dropping the user into a folder without pointing at the file would undo the search.

`/search` keeps every filter in the URL so a filtered result set can be bookmarked and shared.
