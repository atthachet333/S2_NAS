# F25-A — Advanced Governance Audit

Date: 2026-09-16  
Baseline: clean `main` at `a807b4d` (`feat: add PWA and mobile experience`), matching `origin/main`.

This is an audit only. No F25 implementation, deployment, migration, commit, or push is included.

## Executive finding

F16-F18 already provide a strong base: provider-neutral permanent deletion, retention snapshots, legal-hold enforcement, archive state, direct access grants, public-link inventory, and a permission-gated Audit Explorer. The focused F16/F17/F18/trash suite passed **137/137** tests.

The smallest justified F25 is therefore hardening, not replacement. The highest-risk gaps are:

1. **Released legal-hold history is not durable after purge.** `LegalHold.resource` uses `onDelete: Cascade`; after a hold is released, permanently deleting its resource deletes the hold row and its confidential reason/case history.
2. **Retention can be weakened without privileged approval.** Any user who can edit a resource can change or clear its retention assignment. No reason is required.
3. **Legal-hold release does not require a reason.** Both API and UI allow an empty release reason.
4. **Retention reapply is a write-first bulk operation.** It has only a frontend count confirmation, no backend preview, no reason, no transaction/rollback boundary, and can leave partial changes without its final summary audit event.
5. **There is no effective-access review.** The current endpoint returns owner, visibility, and direct grant rows for one resource; it does not assemble organization/admin access, external accounts, public links, or folder-scope effects into one answer.
6. **Privileged-event evidence is inconsistent.** Several sensitive actions have no reason or before/after evidence; policy definition changes are not fully logged; internal grant events are absent from the audit catalog and detail allowlist.

## 1. Existing retention architecture

- `RetentionPolicy` contains name, description, duration-or-forever, active state, ordering, and creator.
- Each `Resource` stores an assigned policy plus a snapshot: `retentionStartAt`, `retentionStartBasis`, `retentionUntil`, and `retentionForever`.
- Start basis is explicit (`CREATED_AT` or human-supplied `MANUAL`); there is no inferred OCR date.
- Editing a policy definition does not silently recalculate existing resources. A separate reapply action recalculates them.
- A document category may supply a default policy only when the resource has no policy already.
- Assignment is per resource. The service accepts files or folders, but there is no declared or computed descendant inheritance model.
- Expiry permits consideration for deletion; it does not automatically delete a live document.

Gap: assignment, change, and clearing use ordinary `canEdit`, so an editor can reduce or remove protection without a governance permission or reason. Reapply is sequential and non-transactional, with no server-side preview.

## 2. Existing legal hold

- Holds are separate rows with reason, optional case reference, creator/time, active state, releaser/time, and optional release reason.
- Creation requires `system:retention:manage`, a non-empty reason, visibility of the target, and no existing active hold.
- Release updates the same row instead of deleting it and adds an audit event.
- Ordinary viewers see hold status but not confidential reason/case data.
- One active hold is allowed per resource. A hold on a folder blocks trash/purge of that folder subtree, because destructive subtree checks inspect all descendant IDs.

Gaps:

- Release reason is optional in service, route, and both UIs.
- `LegalHold.resource` cascades on resource deletion. Released history therefore disappears when the resource is later permanently deleted, contradicting the documented invariant.
- Folder hold scope is not inherited by descendants as an independent policy. A child can be deleted directly unless it has its own hold; only an operation on the held ancestor checks that ancestor.
- There is no case-level hold or multi-resource hold object.

## 3. Delete and purge protections

- Soft delete is reversible and keeps every stored version.
- Legal hold blocks both trash and purge. Retention blocks purge but permits trash.
- Permanent deletion has a preview with resource/file/version counts and a safe block reason.
- The central purge path checks the complete subtree, resource lock, legal hold, and retention before deletion.
- Stored bytes are deleted using each version's recorded provider, so mixed LOCAL/S3 resources do not depend on the current configured provider.
- Manual blocked attempts and physical-delete failures are audited. The automated trash worker skips protected or locked items.

Gaps:

- Manual permanent deletion records only the generic reason `USER`; it does not collect an explicit operator justification.
- A partial physical-storage failure can remove some objects while retaining database metadata. This is safer than deleting metadata falsely, but needs explicit failure/reconciliation evidence and tests under governance constraints.
- The final permanent-delete event does not retain a durable deleted-resource identifier suitable for later resource filtering.

## 4. Archive behavior

- Archive is a reversible lifecycle state independent from trash.
- It preserves bytes, all versions, tags, category, owner, search data, and access grants.
- Archived resources are hidden from normal browsing/recent/client areas, remain searchable internally, and cannot be newly public-shared.
- Existing public links become unavailable while archived and can become usable again after unarchive if not expired/revoked.
- Legal hold permits archive because archive is preservation, not destruction.

Gap: archive and unarchive are audited, but high-volume bulk archive has no backend preview endpoint. This is reversible, so it is lower risk than retention reapply.

## 5. Sharing, guest, and public governance

- Internal sharing uses per-resource `ResourceAccess` rows with EDITOR/VIEWER, download permission, optional expiry, grantor, and timestamps.
- External accounts are explicit users; guest/public links are a separate token-based model.
- Public tokens are stored only as hashes. DTOs and exports omit token/hash/storage internals.
- Public links support default seven-day expiry, explicit no-expiry, preview/download flags, password protection, view/download limits, counters, last access, revocation, and a 20-active-link cap per resource.
- Admin inventory supports status, creator, resource, download, password, and expiry filters, plus summary counts.

Gaps:

- Admin `ACTIVE` filtering/counting considers only revocation and expiry. It can count max-view-exhausted or unavailable archived/trashed resources as active even though DTO status says otherwise.
- Inventory cannot filter `LIMIT_REACHED`, `RESOURCE_UNAVAILABLE`, or stale-by-last-access links.
- Public-link creation/revocation requires no governance reason; revocation audit has counts but no justification.
- Admin inventory is restricted by hard-coded ADMIN/SUPER_ADMIN role checks rather than a dedicated review capability.

## 6. Access model

Effective internal capability is computed on the backend from:

- admin role;
- resource owner/responsible person;
- active direct grant;
- organization visibility;
- system-drive read policy;
- user permissions;
- resource lock for write-like actions.

Expired grants remain visible for history but stop authorizing immediately. Direct grant download denial overrides organization-default download access.

Gaps:

- Internal direct grants do not inherit from folder ancestors. Visibility is copied to new children rather than computed as an access-policy inheritance chain.
- `GET /resources/:id/access` is a raw-resource view, not an admin effective-access review. It omits organization-wide users, admin-derived access, public links, and folder public-share scope.
- There is no organization-wide query answering “who can access this area/resource now?”
- Grant updates overwrite the row and revocation deletes it; audit events must therefore carry complete historical evidence, but current events do not consistently preserve before/after state.

## 7. Owner/responsible-person semantics

- Code, docs, and UI consistently state that resources belong to the organization and `ownerId` is the responsible person, not personal data ownership.
- `createdById` remains historical and is not changed by handover.
- Admin handover has an overview, preview, active-internal-target check, one-transaction transfer, offboarding check, and audit summary.

Gaps:

- Handover and bulk owner change do not require a reason.
- The offboarding/handover queries exclude trashed resources, so a disabled account can remain responsible for items in trash that may later be restored.
- General bulk owner change has no preview step, although the dedicated full handover does.

## 8. Audit Explorer capabilities

- Backend-gated access requires an internal account plus `system:audit:view`; export separately requires `system:audit:export`.
- Filters cover resource, actor, actor type, action, category, preset, date range, failures, and text search.
- There are governance/destructive/public-share presets, resource timelines, cursor pagination, event detail, and CSV export.
- Export uses the same filters, is capped, formula-safe, audited, and omits forbidden secret/storage fields.
- There is no API to edit/delete logs and no automatic audit retention job.

Gaps:

- No explicit “privileged action” dimension/filter; it is inferred from action lists.
- Export is CSV only; JSON does not exist.
- Internal `RESOURCE_ACCESS_GRANTED` / `RESOURCE_ACCESS_REVOKED` are emitted through dynamic action selection but are absent from the event catalog and detail allowlist, so they degrade to unknown/system events with empty details.
- `RESOURCE_LOCKED` logs `hasReason`, while its allowlist expects `reason`, so the Explorer exposes neither useful field.
- Bulk retention reuses `RETENTION_POLICY_ASSIGNED`, but its batch counts/id are not in that event's allowlist.
- Policy create/update/deactivate/delete evidence is incomplete: create/delete/deactivate have no dedicated events; update is logged only when reapply runs.
- “Append-only” is an application/API convention, not database-enforced immutability.

## 9. Privileged action coverage

| Action | Authorization | Reason | Audit strength |
|---|---|---:|---|
| Place legal hold | retention manager | Required | Actor/target/time + hold reference |
| Release legal hold | retention manager | **Optional** | Actor/target/time + hold reference |
| Permanent delete | owner/admin with delete capability | **No explicit reason** | Counts/name/generic USER reason; deleted target ID weak |
| Retention assign/change/clear | any editor | **None** | New state only; prior state incomplete |
| Retention reapply | retention manager | **None** | Summary only if the whole loop reaches the end |
| Lock | owner/admin/lock capability | Optional | Only `hasReason` stored; Explorer allowlist mismatch |
| Unlock | same | **None** | Actor/target/time only |
| Public link create/revoke | share capability | **None** | Conditions/counts, no reason |
| Owner reassignment/handover | owner/admin/owner-manage | **None** | Target/count, incomplete before/after in some paths |
| Access grant/revoke | share capability | **None** | Grant state on create; revoke lacks prior state and catalog support |

## 10. Governance UI today

- Per-resource lifecycle panel: retention assignment, archive/unarchive, hold placement/release, hold badge/history.
- Admin retention page: policy definitions, reapply count confirmation, active holds, release action.
- Trash page: per-item expiry and governance-block status.
- Archive/retention smart views.
- Admin Audit Explorer and CSV export.
- Admin public-link inventory and summary.
- Per-resource internal/public share dialogs.
- Admin ownership/handover, permissions, categories, and system settings pages.
- Bulk metadata dialog for category, owner, retention, and archive with partial-failure reporting.

There is no unified governance dashboard, exception queue, classification administration, effective-access review, or privileged-action review page.

## 11. Backend enforcement gaps

Priority gaps are: retention weakening by ordinary editors; optional legal-hold release reason; released-hold history cascade; ambiguous folder hold/retention scope; no server-side bulk preview; partial reapply; incomplete public-link active computation; and no effective-access review endpoint.

Backend checks are otherwise authoritative. UI hiding is not the sole control for the audited F16-F18 actions.

## 12. Audit and evidence gaps

- Preserve legal-hold history independently of resource lifetime.
- Record explicit reason for every high-risk override/release.
- Record before/after for retention, owner, access, lock, and public-share policy changes where appropriate.
- Give policy definition create/update/deactivate/delete dedicated events.
- Fix catalog/allowlist coverage for internal access and bulk events.
- Keep sensitive hold reason/case evidence behind the narrower hold-manager authorization boundary.
- Define whether database-level audit immutability is required; current protection is API-only.

## 13. Classification gap

The system has document categories, free-form tags, and access visibility (`ORGANIZATION`/`RESTRICTED`), but none is an explicit governance sensitivity classification. There is no `PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED` field, policy mapping, inheritance rule, or classification-change audit event.

Classification is potentially useful, but it should not be added until the organization defines concrete enforcement effects (for example: whether PUBLIC may have guest links, whether CONFIDENTIAL requires expiry, and whether RESTRICTED forbids public links). A label with no backend consequences would be misleading. No automatic classification should be built.

## 14. Access-review gap

Build an effective-access read model before adding new access semantics. For one resource/folder it should enumerate, with source:

- responsible person;
- direct active/expired grants and user status;
- organization visibility and system-drive policy;
- admin-derived access;
- external-account grants;
- active/expired/revoked public links without tokens;
- capability and download permission;
- expiry and last use;
- folder-scope effects where they actually exist.

This can initially be a backend computation over existing schema. Do not claim inherited internal access because the current model does not implement it.

## 15. Public-link governance gap

Correct the active/summary computation first, then add stale-link filtering based on existing `lastAccessedAt` and `createdAt`. A dedicated capability for company-wide link review/revocation is preferable to role-name checks. No token storage or token recovery should be introduced.

## 16. Mobile implications

- Admin navigation is horizontally scrollable on small screens and current admin tables use horizontal overflow.
- Existing governance pages use native `window.confirm` and desktop-oriented tables rather than the shared Sheet/dialog pattern.
- No focused frontend tests exist for Admin Retention, Audit, Public Shares, Ownership, Lifecycle Panel, or Bulk Metadata Dialog.

Any F25 UI should use existing responsive Sheet/dialog primitives, safe-area-aware layouts, visible tap targets, and no hover-only controls. It should add targeted mobile component tests rather than a separate mobile implementation.

## 17. Schema gaps

A migration is justified only for the legal-hold history defect, and later only if approved policy requires classification or formal exceptions.

- **Required to preserve hold history:** decouple released hold evidence from resource cascade while retaining a stable target identity/snapshot.
- **Possible later:** explicit sensitivity classification and policy mapping.
- **Possible later:** durable exception request/approval/expiry/revocation records.
- **Not required initially:** effective-access review, stale-link inventory, privileged event tagging, dashboard counts, or safer bulk preview; these can be computed or represented in code/catalogs.

Any approved migration must follow backup, checked migration, `migrate deploy`, status/drift, empty-DB replay, and restore rehearsal requirements while preserving the known VECTOR exception.

## 18. Test coverage gaps

Evidence run:

```text
npx tsx --test --test-concurrency=1 \
  src/modules/governance/f16.test.ts \
  src/modules/audit/f17.test.ts \
  src/modules/sharing/f18.test.ts \
  src/modules/files/trash-retention.test.ts

137 tests, 137 passed, 0 failed
```

Existing coverage is strong for precedence, subtree purge blocking, archive preservation, public-link token/scope/security, Audit Explorer filtering/export, and trash cleanup. Mixed-provider permanent purge is tested separately.

Missing or insufficient coverage:

- legal-hold history after release **and subsequent permanent resource deletion**;
- mandatory release/override reasons;
- folder-scope semantics when deleting a descendant directly;
- retention reduction/clear authorization;
- reapply preview, rollback/partial-failure, and summary evidence;
- effective-access results across owner/direct/org/admin/external/public sources;
- public inventory status consistency for limit-reached/unavailable resources and stale links;
- internal access grant/revoke catalog and before/after evidence;
- route-level non-admin/forged-ID tests for every new governance route;
- governance enforcement on S3-backed protected content (provider-neutral purge is tested, but not hold/retention denial on S3);
- focused frontend/mobile tests for governance pages and dialogs.

## 19. Recommended F25 implementation sequence

1. **F25-B — Evidence integrity and privileged reasons**  
   Preserve released hold history across purge; require release reason; add explicit reason/before-after evidence for retention weakening/reapply, permanent delete, unlock, public-link revocation, access override, and ownership override; fix event catalog/allowlists.
2. **F25-C — Retention and bulk-policy hardening**  
   Define who may increase vs reduce/clear retention; add backend preview/count; make reapply transactional or explicitly resumable with per-item results; document/test precedence and folder scope.
3. **F25-D — Effective access review**  
   Add a read-only backend computation and admin UI using existing access/public-link models. Do not add inheritance until its policy is explicitly approved.
4. **F25-E — Public-link review hardening**  
   Make inventory status consistent with enforcement; add stale/last-used filters and dedicated review authorization.
5. **F25-F — Privileged audit review/export**  
   Add an explicit privileged/governance event dimension and filters; add JSON export only if a real consumer needs it.
6. **F25-G — Classification, only after policy design**  
   Add explicit sensitivity classification only with approved backend effects, inheritance/conflict rules, audit events, and migration discipline.
7. **F25-H — Dashboard/exceptions, only if still justified**  
   Build actionable counts or a formal exception workflow only after the underlying records and ownership are defined.

## 20. What should explicitly not be built

- No authentication, storage-provider, search, Smart Filing, Document Assistant, PWA, or mobile redesign.
- No automatic or AI-guessed governance classification.
- No retention-triggered deletion of live documents.
- No individual version-delete endpoint.
- No raw token, `storageKey`, physical path, bucket, or provider exposure.
- No second permission engine or duplicate retention model.
- No multi-company tenancy model for this single-company product unless a separate requirement establishes it.
- No generic exception framework, governance dashboard, or vanity metrics before concrete policies and owners exist.
- No destructive bulk cleanup in F25.
- No implementation beyond this audit until the F25-B scope is approved.
