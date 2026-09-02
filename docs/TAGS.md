# TAGS

Tags are organization-wide labels shared by all users, stored in `Tag` and linked through `ResourceTag`.

## Naming

Names are trimmed, whitespace-collapsed, and NFC normalized. Control and format characters are rejected; maximum length is 64 characters. Thai names are fully supported.

`normalizedName` (lowercased) is unique, so `สัญญา` and `สัญญา ` and case variants resolve to a single tag rather than creating near-duplicates.

## Authorization

- Attaching or removing a tag requires `canEdit` on the resource.
- Creating a **new** tag additionally requires `resources:tag:create`; without it a user may only apply tags that already exist (`TAG_CREATE_DENIED`). This keeps the shared vocabulary from fragmenting.
- Tagging a locked resource is rejected with `RESOURCE_LOCKED`.

## Listing

`GET /api/tags` returns tags with a `resourceCount` scoped to resources the caller can see. A tag used only on restricted documents does not reveal itself through a count.

## Endpoints

| Method | Path |
| --- | --- |
| `GET` | `/api/tags?q=` |
| `POST` | `/api/resources/:id/tags` |
| `DELETE` | `/api/resources/:id/tags/:tagId` |

Both mutations log `RESOURCE_TAG_ADDED` / `RESOURCE_TAG_REMOVED` with the tag id and name, so history stays readable after a tag is detached.
