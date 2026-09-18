# F26 — External Workflow: Final Report

Phase status: **F26-A through F26-G complete.** This is the closing record for the phase; `F26_EXTERNAL_WORKFLOW.md` is the living reference for how the feature behaves.

## 1. What F26 delivers

Authenticated, governed collaboration with people outside the organisation: an internal staff member issues a request against a folder, a named external account receives it, submits files through a pinned destination, and internal reviewers approve, reject, request revision, or revoke — with every step auditable and every capability visible to the access review.

It is explicitly **not** anonymous document exposure. There is no unauthenticated workflow path; the guest/public-link modules contain no reference to workflows at all.

## 2. How the phase actually ran

F26 began with an audit (F26-A) rather than a schema, and that audit paid for itself twice:

- It found that the **portal runtime never enforced F25-D classification** — the access review reported CONFIDENTIAL/RESTRICTED portal grants as blocked while the portal kept serving them. F26-A1 closed that before any workflow code was written, because building external collaboration on a gate that disagrees with its own audit report would have propagated the defect.
- It found that `Resource.ownerId` already means *responsible internal person*, which settled the submitted-file ownership question without inventing a rule.

F26-B shipped a request model that wrote a `ResourceAccess` row — and **that was wrong**. `ResourceAccess` is unique per (resource, user), so a workflow silently destroyed any manual grant the assignee already held, unrecoverably. F26-B1 replaced it with an overlay that touches nothing. The corrected design is the one documented here; the mistake is recorded because the reasoning behind the fix only makes sense against it.

## 3. Architecture

**Access is an overlay, never a write.** A workflow carries its own `allowUpload` / `allowDownload` / `expiresAt` and is a grant source in its own right. Manual grants and workflow grants live in separate tables, expire independently, and are merged only at evaluation time in `activeGrantMap` — the single choke point every portal path already passed through. Starting a workflow changes no permission field; ending one removes only what it added; an administrator editing a manual grant mid-workflow is never rolled back.

**The merge is permissive by design**: a workflow may add capability, never subtract it. That follows from the governing invariant — creating a workflow must not weaken access that exists independently of it. It is safe because classification and lifecycle are applied *above* the merge, so no combination of grants can exceed the ceiling.

**Not a hidden second permission path.** The access review reads the same merge helper the runtime uses, enumerates workflow-only assignees who have no `ResourceAccess` row at all, and reports `WORKFLOW` as evidence distinct from `DIRECT` and `INHERITED`.

## 4. State machine

`WORKFLOW_TRANSITIONS` is declared as data, in one place.

```
OPEN               → SUBMITTED, REVOKED
SUBMITTED          → UNDER_REVIEW, APPROVED, REJECTED, REVISION_REQUESTED, REVOKED
UNDER_REVIEW       → APPROVED, REJECTED, REVISION_REQUESTED, REVOKED
REVISION_REQUESTED → SUBMITTED, REVOKED
APPROVED / REJECTED / REVOKED → (nothing)
```

`EXPIRED` is derived from `expiresAt` on every read and **never persisted** — storing it would need a job, and until that job ran an expired request would still look usable. Revocation outranks expiry, so a human decision is never reported as time simply passing.

Only three writes touch the state column in the entire codebase: two compare-and-swap `updateMany` calls guarded by the expected prior state, and one that releases the duplicate-guard slot without changing state.

## 5. Access contribution

| State | Workflow grant contributes |
|---|---|
| `OPEN` · `SUBMITTED` · `UNDER_REVIEW` · `REVISION_REQUESTED` | yes |
| `APPROVED` · `REJECTED` · `REVOKED` · expired | no |

`SUBMITTED` and `UNDER_REVIEW` keep granting deliberately — cutting access the moment someone presses send makes their work look like it vanished while it is merely being reviewed.

Above all of it: `PUBLIC`/`INTERNAL` allow the portal subject to effective access; `CONFIDENTIAL`/`RESTRICTED`, archived and trashed block it in **every** workflow state, and no transition can override that.

## 6. Submission and revision

Destination is pinned server-side from the request row; the client sends only the workflow id and the file, and any destination-shaped field rejects the whole request rather than being ignored. The ordinary upload pipeline is reused — checksum, MIME and size validation, `KEEP_BOTH`, provider abstraction, version invariants — with `ownerId` inherited from the folder and `createdById` the external submitter.

Each resubmission creates a **new Resource**, not a new version. The portal has no version-upload path for external users and version history is closed to them, so versions authored by a submitter would be invisible to that submitter. Prior submissions, their rows and their bytes all survive; the current submission is simply the highest `sequence`, with no mutable pointer stored anywhere.

Review actions carry the `submissionId` the reviewer was judging, so a decision aimed at a superseded revision fails with `WORKFLOW_REVIEW_STALE` rather than recording approval of something nobody read.

## 7. Revocation

A state transition and nothing more: no `revokeAccess`, no deleted workflow row, submission rows, files, or `ResourceAccess`. Access stops because `REVOKED` does not contribute; the evidence survives whole. Revoking an already-expired request is allowed, because "cancelled" and "lapsed" are different facts to an auditor.

## 8. Version history — a deliberate removal

`externalCapabilities` declared `canSeeVersionHistory: false` from the start, marked explicitly as a decision rather than an oversight, but the portal version routes never consulted it. External users could list, open and download the full version history of internal documents, exposing internal working rhythm unrelated to their own work.

F26-F enforces the flag. The current file stays viewable and downloadable under existing permissions; the *history* is closed. **This removed behaviour that F18-era work built and tested** — four tests asserted the opposite and were replaced rather than quietly deleted. Customers' own submission history is unaffected and lives on the workflow screen.

## 9. Compensation: mitigated, not solved

If the bind after an upload fails, the resource and its bytes are deleted. If that deletion itself fails, a durable `STORAGE_CLEANUP_FAILED` audit row records the orphaned resource, workflow and stage, so the bytes stay findable and the existing `ORPHAN_OBJECT` storage scan has a reference point.

No retry platform was added: retrying while storage is down fails identically, and the gap was visibility, not attempts. **Orphan bytes can still be created during a storage outage.** That risk is real and is now observable rather than silent.

## 10. Known limitations

1. **Real-browser mobile QA not exercised.** Structure, targets, safe areas and offline behaviour are covered by tests at 320–1024+ by construction, but no live device or browser run was performed.
2. **Cleanup under storage outage is mitigated, not fixed** (§9).
3. **Revision rounds are unbounded** — nothing caps cycling between `REVISION_REQUESTED` and `SUBMITTED`.
4. **No discussion thread** — a reviewer cannot comment without also making a decision.
5. **Workflow history filters in memory** over the most recent 500 governance events; fine at current volume, needs a query-side filter at scale.
6. **Manual `revokeAccess` still deletes the `ResourceAccess` row**, destroying the review's record that a customer once had access. Pre-existing, outside F26, and never used by workflow logic — but still true of manual sharing.
7. **Legacy test-harness orphans** remain in the historical corpus; out of scope by instruction.
8. No notifications. The backend has no mail, push or webhook infrastructure and F26 did not add one.
9. Folder-only targets; one active request per (folder, assignee).
