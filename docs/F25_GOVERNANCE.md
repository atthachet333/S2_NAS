# F25-B — Legal Hold, Retention, and Privileged Governance Hardening

สถานะ: implemented and verified on `main` working tree; **ยังไม่ commit / push / deploy application**

เอกสารนี้ครอบคลุมเฉพาะ F25-B ไม่ขยายไป F25-C, F25-D หรือ F26

## 1. Security invariants

1. ลำดับการป้องกันการทำลายข้อมูลคือ **Legal Hold > Retention > deletion** เสมอ
2. Legal Hold ที่ยัง active ขวางทั้ง trash และ permanent delete; Retention ขวาง permanent delete ตามอายุ/forever
3. การปลด Legal Hold ต้องมีเหตุผลที่ไม่ว่างและยาวไม่เกิน 500 ตัวอักษร
4. หลักฐาน Legal Hold เป็น immutable snapshot แยกจากวงจรชีวิตของ `resources` และ `legal_holds`
5. ผู้แก้ไขเอกสารทั่วไปกำหนดหรือเพิ่มความเข้มงวดได้ แต่ลด/ล้าง Retention ไม่ได้
6. การลด/ล้าง Retention ต้องมี `system:retention:manage` (หรือ ADMIN/SUPER_ADMIN) และเหตุผล
7. ทุก privileged mutation ตรวจ authorization และสถานะล่าสุดอีกครั้งที่ backend; UI ไม่ใช่ security boundary
8. Resource mutation กับ audit row อยู่ใน transaction เดียวกัน

## 2. นิยามการเปลี่ยน Retention แบบ deterministic

ลำดับความคุ้มครองจากมากไปน้อย:

`retain forever` > `finite date ที่ช้ากว่า` > `finite date ที่เร็วกว่า` > `ไม่มี policy`

| ก่อน | หลัง | ผล |
|---|---|---|
| none | finite/forever | `APPLIED` |
| finite | later finite | `STRENGTHENED` |
| finite | earlier finite | `WEAKENED` |
| finite | forever | `STRENGTHENED` |
| forever | finite | `WEAKENED` |
| policy ใด ๆ (แม้หมดอายุแล้ว) | none | `CLEARED` |
| snapshot เท่ากัน | snapshot เท่ากัน | `UNCHANGED` |

การเทียบใช้ snapshot ที่ persisted (`retentionUntil`, `retentionForever`, `retentionPolicyId`) ไม่เดาจากชื่อ policy

## 3. Legal Hold evidence lifecycle

ตาราง `legal_hold_history` เก็บหนึ่ง snapshot ต่อ Legal Hold:

- original hold/resource IDs
- resource name, type, drive scope ณ เวลาวาง
- hold reason และ case reference
- ผู้วาง/เวลา
- release reason, ผู้ปลด/เวลา
- active/released state

ไม่มี foreign key ไป `resources` หรือ `legal_holds` โดยตั้งใจ ดังนั้น resource purge ไม่ cascade หลักฐานนี้ ผู้สร้างยังเป็น FK แบบ `RESTRICT` เพื่อไม่ให้ลบตัวตนผู้วางหลักฐานเงียบ ๆ; ผู้ปลดเป็น `SET NULL` แต่เวลาปลดและเหตุผลยังคงอยู่

API สำหรับประวัติถาวรคือ `GET /legal-hold-history` และจำกัดให้ผู้จัดการ Retention เท่านั้น รายการตอบกลับระบุ `resourceDeleted` เมื่อ resource ต้นทางไม่อยู่แล้ว

## 4. Reapply protocol

Reapply แบ่งเป็นสองคำขอ:

1. `GET /retention-policies/:id/reapply-preview` เป็น read-only คำนวณ attempted/changed/unchanged/blocked/permission-denied, Legal Hold conflicts และ potential weakening
2. `POST /retention-policies/:id/reapply` รับ signed `previewToken` และเหตุผล (บังคับเมื่อมี weakening)

Token ผูกกับ fingerprint ของ policy และ resource snapshot ทุกตัว, ปิดบัง resource identifiers ด้วย authenticated encryption (AES-256-GCM), และหมดอายุใน 15 นาที ขั้น execute ตรวจซ้ำ:

- token signature / policy identity / expiry
- policy fingerprint
- resource existence และ not-deleted
- authorization ล่าสุด
- active Legal Hold ล่าสุด
- resource fingerprint และ policy assignment ล่าสุด
- privileged reason สำหรับ weakening

## 5. Atomicity, partial outcomes, and retry

เลือก **Model B: transaction ต่อ resource** เพราะชุด reapply อาจมีหลายพันรายการและบางรายการถูก Legal Hold หรือถูกแก้พร้อมกัน การ rollback ทั้ง batch จะทำให้รายการที่ปลอดภัยไม่เดินหน้าและเพิ่ม lock contention

ผล execute มีโครงสร้างคงที่:

```text
attempted, changed, unchanged, blocked, failed, errors[]
```

- แต่ละ resource update กับ audit สำเร็จหรือ rollback พร้อมกัน
- Hold เป็น `blocked`; permission/stale/validation/unknown เป็น `failed`
- รายการอื่นเดินหน้าต่อและ UI ต้องแสดง partial result
- validation failure ก่อน mutation retry ด้วย token เดิมได้
- หลัง resource เปลี่ยนแล้ว token เดิมถูกตรวจเป็น stale จึงไม่เปลี่ยนซ้ำ (safe replay, ไม่ใช่ idempotency key แบบคืนผลเดิม)

Single-resource assign/clear และ reapply ใช้ optimistic compare กับ `updatedAt`; write ที่แพ้ race ได้ `RETENTION_STATE_STALE` และไม่มี audit success ปลอม

## 6. Normalized governance events

- `RETENTION_APPLIED`
- `RETENTION_STRENGTHENED`
- `RETENTION_OVERRIDE_WEAKENED`
- `RETENTION_CLEARED`
- `RETENTION_REAPPLY_STARTED`
- `RETENTION_REAPPLY_COMPLETED`
- `RETENTION_REAPPLY_PARTIAL`
- `LEGAL_HOLD_CREATED`
- `LEGAL_HOLD_RELEASED`

Retention mutation events เก็บ before/after policy ID, retention date, forever flag, source และ override reason เมื่อจำเป็น Legal Hold release เก็บ before/after, stable resource identity และ release reason เหตุผลการวาง Hold ไม่ถูกเผยแพร่ใน Audit Explorer เพื่อคง data minimization; อ่านจาก protected history endpoint เท่านั้น

## 7. UI behavior

- Admin Retention ใช้ mobile-friendly Sheet สำหรับ reapply preview และ Legal Hold release
- preview แสดง counts ก่อนยืนยัน; execute แสดง changed/unchanged/blocked/failed และ error codes จริง
- ช่องเหตุผลแสดงและบังคับเมื่อ preview พบ weakening
- Lifecycle panel และ bulk metadata ส่ง override reason ไป backend
- Legal Hold release ทุก entry point ต้องกรอกเหตุผล
- UI ไม่ถือว่าคำขอสำเร็จทั้งก้อนเมื่อ backend รายงาน partial

## 8. Migration and live-data evidence

Migrations:

- `20260916113000_phase_f25b_governance_hardening`
- `20260916114500_phase_f25b_history_updated_at_alignment` (forward-only correction of the Prisma/database default contract found by drift verification)

- additive table only
- backfill existing Legal Holds ด้วย resource snapshot
- ไม่ rewrite resources, holds, retention assignments หรือ audit rows
- pre-migration backup: `cmu3kl4k60001wqb4iw099kfh` (1,765 files, DB 83.4 MB, total 1.3 GB)
- migration status: database schema up to date (27 migrations)
- full replay on a disposable database: passed all 27 migrations
- schema drift check: passed; only the explicitly migration-managed MariaDB VECTOR index remains outside Prisma datamodel support
- the smoke checker was tightened so an unrelated altered column cannot be mistaken for the permitted vector-index difference

Live counts:

| Entity | Before | Immediately after migration |
|---|---:|---:|
| resources | 1,925 | 1,925 |
| legal holds | 2 | 2 |
| released holds | 2 | 2 |
| retention assignments | 0 | 0 |
| audit rows | 10,845 | 10,846 |
| durable hold history | n/a | 2 |

Audit เพิ่ม 1 แถวจากการสร้าง pre-migration backup ตามปกติ ไม่ใช่ migration rewrite

หลัง full regression suite: resources 1,925; holds 2; released holds 2; retention assignments 0; durable history 2 (business counts ยังเท่าเดิม) ส่วน audit rows เป็น 10,962 เพราะ integration/recovery suites ตั้งใจเขียน audit ผ่าน production code paths ระหว่างการพิสูจน์ ไม่ใช่ migration rewrite

## 9. Verification

- focused F25-B matrix: 7/7 passed — deterministic comparison, audit projection/data minimization, privilege/reason gates, purge survival, read-only preview, all-changed/unchanged/mixed, active Hold, permission denial, stale resource, validation failure, retry/replay, forged token/resource ID
- focused F16/F17/F18/trash regression: 142/142 passed
- backend typecheck/build: passed
- frontend typecheck/build: passed
- frontend full test suite: 438/438 passed
- backend full test suite: 1,108/1,108 passed (2 feature-flag suites skipped intentionally)
- restore rehearsal exercised by the full suite: passed, including byte/storage consistency and cleanup of the isolated stage

## 10. Operational notes

- Keep `JWT_ACCESS_SECRET` at least 32 characters in production; production config already rejects weaker secrets
- Monitor `RETENTION_REAPPLY_PARTIAL`, `RETENTION_STATE_STALE`, and repeated override actions
- A permanent user-deletion workflow must explicitly preserve or pseudonymize evidence; the history creator FK intentionally prevents silent deletion
- No application deployment, commit, or push is part of F25-B

## 11. F25-C effective access model

`GET /api/resources/:id/access-review` is an admin-only, read-only view of the access that is usable now. It returns only safe resource and identity fields; storage keys, provider paths, password hashes, and public-link token hashes are never selected for the response.

Access sources proven by the existing authorization code are:

- `OWNER`: the resource owner, subject to an active internal account and the normal `resources:read` gate
- `DIRECT`: a non-expired `ResourceAccess` row on the resource
- `ROLE`: administrator access, organization visibility, or system-drive visibility combined with the user's current RBAC permissions
- `INHERITED`: only authenticated portal users and anonymous links rooted at an ancestor folder; internal `ResourceAccess` rows do not inherit
- public/guest link: `PublicShareLink`, used by an anonymous token holder and kept separate from authenticated portal users

There is no company/workspace key in the current schema. Internal/external account type is therefore the enforceable boundary: external users cannot enter internal routes, and portal access comes only from explicit resource grants. `organizationName` is descriptive, not an authorization scope. No access is fabricated from a “responsible person” field; ownership is the only persisted responsibility concept that grants access.

## 12. Merge, precedence, and download semantics

Internal users are evaluated with the production `capabilities()` function rather than a second approximation. Owner is reported as `OWNER`; otherwise edit capability is `EDITOR` and view-only is `VIEWER`. A direct grant remains visible as evidence even when organization/admin access also applies. Importantly, a direct grant's `allowDownload` overrides the organization default exactly as runtime authorization already does.

Portal inheritance follows the existing nearest-active-grant-wins rule, not strongest-role-wins. A direct grant on the child therefore overrides an ancestor grant; if it expires, the next active ancestor grant becomes effective. Role and download both come from that same nearest active grant. All direct and inherited evidence remains visible.

Disabled/suspended/invited principals and expired assignments are reported as assigned evidence with `usable=false`; they do not count as effective. User deletion currently cascades `ResourceAccess`, while resource ownership is protected by a foreign key, so the current schema has no orphaned principal snapshot to show.

## 13. Public links and portal governance

`shareStatus()` is the authoritative link status used by anonymous admission, resource review, admin inventory, admin summary, and active-link creation limits:

- `ACTIVE`: not revoked, not expired, usage limits still permit a real operation, and the root resource is active/not trashed
- `EXPIRED`: time elapsed
- `REVOKED`: explicitly revoked
- `LIMIT_REACHED`: view limit exhausted, download-only limit exhausted, or the record grants no usable operation
- `RESOURCE_UNAVAILABLE`: root resource is archived, trashed, or missing

The admin UI groups the last two as “ใช้งานไม่ได้”. An inherited folder link is additionally unusable for a reviewed descendant if any node from the link root to that descendant is archived or trashed. Active summary counts now derive from `shareStatus()` and therefore exclude revoked, expired, exhausted, and resource-unavailable rows.

Anonymous guest links and authenticated portal users remain separate. Public links have no guest identity; audit evidence uses the safe link ID. Portal access has a real `EXTERNAL` user, expiry, role, download flag, and folder inheritance. There is no separate guest-token table or last-access field for portal grants in the current model.

Revocation remains the existing explicit, authorized, audited `DELETE /public-share-links/:id` mutation. The access-review endpoint never mutates or bulk-revokes.

## 14. Review UI and export safety

Admins get “ตรวจสอบการเข้าถึง” in resource details. The responsive Sheet uses cards on narrow screens and shows effective role, direct/inherited/role/owner evidence, download permission, inactive assignments, portal users, and direct/inherited public links. The existing admin public-link inventory now includes an unusable filter/count.

`GET /api/resources/:id/access-review/export` emits UTF-8 CSV and writes `ACCESS_EXPORT_CREATED`. CSV cells beginning with `=`, `+`, `-`, or `@` are prefixed with an apostrophe before RFC-style quoting. The export contains subject, role, source, inherited-from, download, expiry, and status only—never token/hash, storage key, provider path, or local path.

## 15. F25-C known limits

- The admin public-link summary computes authoritative status in memory because usage-limit comparisons involve two columns; this is correct for the current inventory but should move to a database projection if link volume becomes large.
- Effective review enumerates active internal identities to answer “who”, so response size grows with workforce size. No security-decision cache is used.
- Portal grant records do not persist last-access time, and deleted users leave no identity snapshot after cascading grant deletion.
- There is one organization boundary in the current data model; F25-C does not invent company tenancy or sensitivity classification.

## 16. F25-D sensitivity classification — what it is, and what it deliberately is not

Classification answers exactly one question: **how far outside the organization may this resource be exposed?** It does not answer "who inside may see it" — `visibility` already did that before F25-D and still does, enforced in `capabilities()` and `visibilityScope()`.

That split was a deliberate finding, not a simplification. The F25-D audit started by checking whether an equivalent field already existed. It did: `ResourceVisibility { ORGANIZATION | RESTRICTED }`. Giving classification authority over internal access too would have produced two permission systems that can contradict each other, with no principled answer for which wins — a direct source of vulnerabilities. So the new enum was scoped to the gap that genuinely had no owner.

**The gap it closes.** Before F25-D, no external channel consulted `visibility` at all. `resourceAvailableToGuests` checked `deletedAt` and `lifecycleState` and nothing else. A document restricted to three named people internally could be published to an anonymous public link, and no gate objected.

| Level | Anonymous public link | Portal (external account) | Extra requirement |
|---|---|---|---|
| `PUBLIC` (สาธารณะ) | link may exist* | allowed | — |
| `INTERNAL` (ภายใน) | blocked | allowed | — |
| `CONFIDENTIAL` (ลับ) | blocked | blocked | — |
| `RESTRICTED` (จำกัดการเข้าถึง) | blocked | blocked | `visibility` must be `RESTRICTED` |

`RESTRICTED` and `CONFIDENTIAL` close the same external channels. Without the last column, `RESTRICTED` would be a label that sounds stricter and does nothing — so it carries an enforced invariant instead. The system **never sets `visibility` itself** to satisfy it: changing `visibility` withdraws access from people who have it, which must be a decision someone makes, not a side effect of applying a label. The change is refused with `CLASSIFICATION_VISIBILITY_CONFLICT` and the caller is told what to do first.

**Updated by Link Lock:** *a `PUBLIC` classification permits a share entry point to *exist*; it no longer means anonymous visitors may read the document. All document content requires authentication — see [LINK_LOCK_AUTH_REQUIRED.md](LINK_LOCK_AUTH_REQUIRED.md).

Classification can only ever **subtract**. Setting `PUBLIC` grants no one access to anything; it only permits a public link to be created. Who can actually reach the document still depends on `visibility`, direct grants, and role, unchanged.

## 17. Enforcement points

The authoritative `shareStatus(link, resource, now)` from F25-C gained one status, `CLASSIFICATION_RESTRICTED`, evaluated after the human-driven states. If a link was revoked, the honest reason is revocation, not classification. `ResourceState` makes `classification` **required**, so the compiler — not a runtime failure — finds any call site that forgets to select it. That is what surfaced the guest-admission path during implementation.

Three enforcement points, one policy module:

- **Link creation** refuses with `SHARE_CLASSIFICATION_RESTRICTED` rather than minting a link that `shareStatus` would reject a second later. A system that hands out a link it will refuse makes the user discover its mistake in front of their customer.
- **Guest descent and listing.** A public folder link previously let a guest walk into and list every descendant with no per-child check. `resourceExposableToGuests` now runs at **every level** of the descent, and `listShareChildren` filters in SQL. Classification does not inherit downward at read time, so this is the indispensable other half: an open folder does not open the closed documents inside it.
- **Portal effective access.** Access is computed under the existing rules first, then the ceiling is applied on top. Entries become `usable: false` with status `CLASSIFICATION_RESTRICTED`, and **every evidence row is retained**. An auditor who sees an empty table concludes no one was ever granted access, which would be false.

**Creation-time inheritance, not read-time inheritance.** A new child copies its parent's classification into its own row, exactly as `visibility` already worked. Read-time inheritance would mean reclassifying one folder silently changes the exposure of thousands of documents with no per-document trace. Root-level resources default to `INTERNAL` — conservative, and never `PUBLIC`.

## 18. Changing a classification

Raising is ordinary: anyone who can edit the resource may do it, no reason required, because closing a channel fails safe. Lowering is privileged and needs `system:classification:declassify`, which is **excluded from the ADMIN role by default** and granted case by case — if every admin held it automatically, "privileged" would describe nothing. A downgrade also requires a reason of at least 10 characters; a mandatory field that accepts `.` is not a mandatory field. The privilege check and the reason check are independent, and both are tested as such.

**Legal Hold outranks classification.** Lowering is refused with `CLASSIFICATION_BLOCKED_HOLD` while a hold is open — declassifying material held for an investigation would defeat the hold entirely. Raising is not blocked, because stricter agrees with the hold's intent. Retention is untouched and independent in both directions.

`classifiedAt` separates "a person decided this" from "the system's default". A report that counts defaults as classified lies to the auditor. It is `null` after migration and after inheritance, and is only set when someone acts — which is also why re-confirming the current level is accepted once (recorded as `CLASSIFICATION_ASSIGNED`) and rejected as `CLASSIFICATION_UNCHANGED` thereafter.

Three distinct audit actions — `CLASSIFICATION_ASSIGNED`, `CLASSIFICATION_UPGRADED`, `CLASSIFICATION_DOWNGRADED` — carry actor, resource, before, after, reason, timestamp, and the impact counts as they were shown to the person who pressed the button. Separate actions let an auditor filter "every downgrade this quarter" without reading metadata row by row.

## 19. Impact is reported before the change, never applied silently

`GET /api/resources/:id/classification/impact?level=…` is read-only and returns what would stop working, computed by the same `shareStatus` the guest gate uses. Direct links and ancestor-folder links are counted **separately**: a direct link dies, while an ancestor link keeps working and merely stops listing this document. One combined number would tell the admin their whole folder link is about to break.

Nothing is deleted or rewritten. Link rows stay, grant rows stay, `visibility` stays. Restoring the previous classification restores the previous behaviour with no re-creation — **classification closes doors, it does not destroy keys.**

## 20. Migration and live-data evidence (F25-D)

Two additive migrations: `20260916140000_phase_f25d_classification` (enum column defaulting to `INTERNAL`, plus an index) and `20260916150000_phase_f25d_classified_at` (`classifiedAt` nullable). No data is rewritten and nothing is dropped. Replay from scratch on a disposable database passed; the only drift remains the migration-managed MariaDB `VECTOR INDEX` that Prisma's datamodel cannot express, unchanged since F23.

Live audit before applying policy, per the "do not surprise live data" requirement:

- 1,917 live resources, all `INTERNAL`, **0 explicitly classified by a person** — reported as the system default rather than as completed classification.
- 1 public link total, already revoked and expired. **0 live links disabled by the new policy.**
- 0 external portal grants, so 0 blocked.
- 0 resources violating the `RESTRICTED` visibility invariant.

## 21. F25-D known limits

- Classification is per-resource with creation-time inheritance only. There is no bulk reclassification of an existing subtree; changing a folder today does not touch documents already inside it. This is intentional for auditability, but an operator reclassifying a large existing folder must currently do so document by document.
- `system:classification:declassify` is held only by `SUPER_ADMIN` after sync. Granting it to others requires an explicit role change.
- The impact preview counts ancestor links and direct links, but does not enumerate *which* customers are affected by a blocked portal grant; the access review answers that separately.
- `tsconfig.json` excludes `*.test.ts`, so the fail-closed required-field typing protects production call sites only. Test fixtures that omit `classification` surface at runtime instead of compile time.
