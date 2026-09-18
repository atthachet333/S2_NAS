# F26 — External Workflow

Controlled, **authenticated** collaboration with people outside the organization. This is not anonymous document exposure: every participant has an account, every capability comes from an explicit grant, and every grant remains visible to the access review.

Status: F26-A through F26-G are implemented — audit, portal enforcement, request foundation, grant preservation, portal surface, controlled submission, review, revision/resubmission, revocation and expiry.

## 1. A workflow grants access as an overlay, and never writes over anything

`ResourceAccess` permits exactly one row per (resource, user). F26-B's first attempt had workflow creation `upsert` that row, which silently destroyed the level, download flag and expiry an administrator had set by hand, with no way to recover them. F26-B1 corrects this.

**A workflow now touches no `ResourceAccess` row at all.** The request already carries its own terms — `allowUpload`, `allowDownload`, `expiresAt` — so it is a grant source in its own right. Manual grants and workflow grants live in different tables, expire independently, and are merged only when access is evaluated. The consequences are the ones that matter:

- Starting a workflow changes no existing permission field.
- Ending one removes what it added, with nothing to restore.
- An administrator who edits the manual grant mid-workflow has that decision take effect immediately, and it is never rolled back.

That last point is why snapshot-and-restore was rejected (§7).

**This is not an invisible second permission system.** Both sources are merged at one place for enforcement (`activeGrantMap`, the single choke point every portal path already passes through), and the F25-C review reads the same merge helper and reports each source as separate evidence. An auditor sees both provenances and can explain the combined result — which is the property that makes the overlay legitimate rather than a hidden back door.

## 2. The request model

`ExternalWorkflowRequest` — one additive table, no existing table altered.

| Field | Meaning |
|---|---|
| `title`, `instructions` | What the recipient is being asked to do |
| `targetResourceId` | The folder the work concerns |
| `externalUserId` | The assignee — must be an `EXTERNAL`, `ACTIVE` account |
| `state` | Stored workflow state (see §3) |
| `expiresAt` | When access stops. `null` = no expiry, matching existing sharing policy |
| `dueAt` | When the work is expected. An expectation, not a gate |
| `allowUpload`, `allowDownload` | Mapped to grant semantics (§5) |
| `activeSlot` | Duplicate guard (§6). Not a state, never shown to users |
| `createdById` | The internal staff member who made the decision |

Deliberately **not** included: comment threads, notification state, templates, multi-step approval chains, reassignment history. Each is its own feature; none is needed to create a request.

The target is **folder-only** for now. Almost every outward task ends with a file coming back, which needs somewhere to land. Supporting file-level requests would force an answer to "where does the response go?" before there is any submission specification to anchor it.

## 3. State, and why EXPIRED is not one

Stored: `OPEN · SUBMITTED · UNDER_REVIEW · REVISION_REQUESTED · APPROVED · REJECTED · REVOKED`. New requests start `OPEN`.

`WORKFLOW_TRANSITIONS` is the single authority, declared as data rather than scattered `if`s — rules spread across call sites are the rules that contradict each other once somebody adds a path and misses an old one.

| From | May become |
|---|---|
| `OPEN` | `SUBMITTED` · `REVOKED` |
| `SUBMITTED` | `UNDER_REVIEW` · `APPROVED` · `REJECTED` · `REVISION_REQUESTED` · `REVOKED` |
| `UNDER_REVIEW` | `APPROVED` · `REJECTED` · `REVISION_REQUESTED` · `REVOKED` |
| `REVISION_REQUESTED` | `SUBMITTED` · `REVOKED` |
| `APPROVED` / `REJECTED` / `REVOKED` | **nothing** |

Terminal states have no exit on purpose. Reopening a closed request makes the history unreadable about whether the work ever finished; if more work is needed, issue a new request, which carries its own trail.

**`EXPIRED` is derived, never stored.** Storing it would require a background job to write it, and in the window before that job runs, an expired request would still look usable. That is a hole, not a delay. `effectiveWorkflowStatus(request, now)` is the single authority:

1. `REVOKED` wins first — revocation is a human decision and must not be masked by the mere passage of time. An auditor seeing "expired normally" for something that was urgently revoked has lost the real reason.
2. Then expiry, compared against the current time.
3. Otherwise the stored state.

No route may re-derive `expiresAt < now` on its own. The day the rule changes, the one forgotten copy is the one that keeps letting an external user work after their access ended.

## 4. Classification and lifecycle

F26 invents no exceptions. It calls `resourceExposableToPortal` — the same gate F26-A1 put in front of the portal, which in turn calls F25-D's `allowsExternalAccess`.

| Target classification | Workflow creation |
|---|---|
| `PUBLIC` | allowed |
| `INTERNAL` | allowed |
| `CONFIDENTIAL` | refused — `WORKFLOW_TARGET_CLASSIFICATION_BLOCKED` |
| `RESTRICTED` | refused — `WORKFLOW_TARGET_CLASSIFICATION_BLOCKED` |

Trashed or archived targets are refused with `WORKFLOW_TARGET_UNAVAILABLE`. Creating a request on a blocked folder would mint a grant the portal rejects on every use: the recipient sees work arrive and cannot open it, and nobody can explain why.

Internal staff get the *specific* reason, unlike external users who always get a uniform "not found". Staff can already see the folder, so naming the cause reveals nothing new — and without it they cannot tell what to fix first.

If a folder becomes confidential or is archived **after** a request exists, the request disappears from the assignee's list rather than lingering as an item that errors when tapped.

## 5. Permission mapping

No new permission vocabulary. The flags select from what already exists:

| `allowUpload` | Grant level | Portal role |
|---|---|---|
| `false` | `VIEWER` | `VIEWER` (read only) |
| `true` | `EDITOR` | `CONTRIBUTOR` (add files; cannot alter or delete existing ones) |

`allowDownload` stays explicit and is copied to the grant unchanged. The portal already reduces `EDITOR` to "may add, may not modify", so adding a workflow-specific level would create a second vocabulary immediately.

Both flags `false` is permitted — a request to read instructions and acknowledge is legitimate. Invalid *types* are rejected rather than silently coerced: quietly repairing input means the person who issued the instruction misunderstands their own instruction forever.

`dueAt` must be in the future and must not fall after `expiresAt`. Work due after the door closes can never be delivered.

## 6. Duplicates and concurrency

**Rule: at most one active request per (target folder, assignee).** Active means not terminal, not revoked, not expired. A different assignee on the same folder is fine — the constraint is on the pair.

Enforced in the database, not in the UI. `activeSlot` holds `"<targetId>:<assigneeId>"` while active and `NULL` otherwise; MySQL unique indexes permit repeated `NULL`s, which yields the partial unique index MySQL does not offer directly. An application check before writing still loses to two simultaneous clicks; a unique index does not. Two concurrent creations produce exactly one winner and one deterministic `WORKFLOW_ALREADY_ACTIVE`.

Because expiry is never written, an expired request still holds its slot. Creation releases a stale slot inside the same transaction before taking it. The slot is a concurrency guard, not a state — `EXPIRED` remains purely derived, and the old request keeps its row and its stored state as evidence.

## 7. Merge semantics, atomicity, and why snapshots were rejected

**The merge is permissive: a workflow may add capability, never subtract it.** Effective level is the highest of the active sources, `allowDownload` is true if any active source allows it, and an active source with no expiry means no expiry.

This is not a convenience choice. The governing invariant is that creating a workflow must never weaken access that exists independently of it. A restrictive merge would mean issuing a task silently revokes a download permission the customer has held for a year — a side effect nobody asked for. A workflow's `allowDownload: false` means "this task does not need downloads", not "revoke their downloads"; restricting standing access is an administrator's decision, made by editing the manual grant.

Permissiveness is safe here **because the ceiling sits above it.** Classification (F25-D) and lifecycle are applied at the portal gate *after* merging, so no combination of grants can exceed them. Sources that have expired are discarded before merging, so an expired manual grant contributes nothing.

**Alternatives rejected.** Multiple `ResourceAccess` rows with a source discriminator would require dropping the unique constraint that `capabilities()` depends on — it calls `resource.access.find(...)`, which would silently pick one arbitrary row and mis-evaluate internal permissions. Snapshot-then-restore would go stale the moment an administrator edits permissions during an active workflow, and restoring would overwrite their newer decision with a value nobody wants any more. The overlay has neither failure mode.

**Atomicity.** The workflow row and its audit event are written in one transaction; authorization runs before it opens, so permission checks never hold write locks. There is no cross-table write to coordinate any more — a manual grant change and a workflow change touch different tables, so a lost update between them is structurally impossible rather than merely unlikely.

## 8. Ending a workflow

Setting a terminal state (`APPROVED`, `REJECTED`, `REVOKED`) or letting the request expire removes the workflow's contribution from the merge on the very next evaluation. Nothing is deleted and nothing is restored: any manual grant was never touched, and the workflow row survives as evidence with its stored state intact.

This is already proven rather than merely designed for — the tests drive every terminal state and expiry and confirm that workflow-derived access stops while independent manual access continues unchanged.

The existing `revokeAccess` **deletes** the `ResourceAccess` row, erasing the review's record that a customer ever had access. Workflow revocation must never use it; a state transition is sufficient and non-destructive. F26-B1 implements no transitions — F26-G will add the routes.

## 9. API

Internal (requires `resources:share`, ADMIN or SUPER_ADMIN):

- `POST /api/external-workflows` — create; returns 201 with a safe DTO
- `GET /api/external-workflows` — list, filterable by derived status, target, assignee
- `GET /api/external-workflows/:id` — detail

Assignee-facing (external accounts only):

- `GET /api/portal/workflows` — the caller's own requests only
- `GET /api/portal/workflows/:id` — detail, scoped to the caller
- `POST /api/portal/workflows/:id/submissions` — multipart; file only, destination pinned server-side

Review and revocation (internal, same authorization as sharing the target folder):

- `GET /api/external-workflows/:id/history` — chronology from the audit log
- `POST /api/external-workflows/:id/review/start`
- `POST /api/external-workflows/:id/review/approve` — reason optional
- `POST /api/external-workflows/:id/review/reject` — reason required
- `POST /api/external-workflows/:id/review/request-revision` — reason required
- `POST /api/external-workflows/:id/revoke` — reason required

Review endpoints accept an optional `submissionId`: the revision the reviewer is judging. It never selects what happens — it only lets the server refuse a decision aimed at a superseded revision.

The assignee route takes **no user parameter at all**; scope comes from the token. A parameter that can carry a user id is a parameter that will one day carry someone else's. Status filtering happens after derivation, never in SQL — filtering `state = OPEN` in the database would happily return expired requests.

No response contains a storage key, provider, filesystem path, token, or `activeSlot`.

## 10. Audit

`EXTERNAL_WORKFLOW_CREATED`, categorised under `SHARING` rather than `CLIENT`: it records an internal staff decision to open a document outward, which is what an auditor traces from the sharing side.

Recorded: actor, workflow id, target resource, assignee id, permission summary, resulting access level, expiry, due date, timestamp. **Not** recorded: the instructions text, which is free-form and may describe the work or the customer in detail. It already lives on the request row; copying it into logs widens exposure for no investigative gain.

`EXTERNAL_SUBMISSION_CREATED` sits under `CLIENT`, since it records a customer action. It carries actor, workflow id, submitted resource id, sequence and timestamp — never file contents, storage keys or tokens. The submitted file also produces the ordinary `EXTERNAL_FILE_UPLOADED` event from the shared upload path.

`EXTERNAL_REVIEW_STARTED`, `EXTERNAL_REVIEW_APPROVED`, `EXTERNAL_REVIEW_REJECTED`, `EXTERNAL_REVISION_REQUESTED` and `EXTERNAL_WORKFLOW_REVOKED` are separate codes under `SHARING`, each carrying actor, workflow, current submission and resource ids, before/after state, reason where applicable, and timestamp. Separate codes rather than one code with a result field, so "how many rejections this quarter" is a filter instead of a metadata scan. The chronology endpoint reads these back rather than storing history twice.

**There is deliberately no `EXTERNAL_WORKFLOW_OPENED` event.** Opening the list happens on every screen load, and recording each one would bury the events that carry meaning — the same reasoning that keeps the blocked-delete events limited to deliberate human attempts rather than every sweep. Opening an actual document is still recorded as `EXTERNAL_RESOURCE_VIEWED`, unchanged.

## 11. The assignee's portal surface (F26-C)

Two screens, reached from the portal shell. There is **no global NAS navigation** anywhere in them, and none is possible: the list comes from `GET /api/portal/workflows`, which takes no parameters at all and scopes itself from the token.

The list shows title, status, target folder name, due date, whether uploading is allowed, and how many files have been sent. Detail adds the instructions, the submitted files and the upload control. Neither carries the creator's identity, storage keys, provider names, paths, `activeSlot`, or any metadata about resources outside the request.

**Status is never computed in the browser.** The backend returns the derived status and a `canSubmit` boolean; the UI only renders them. A frontend clock that is wrong — or a rule that changes server-side — would otherwise produce a screen that disagrees with what the server enforces, offering buttons that fail or hiding ones that would work. A test asserts the frontend contains no expiry comparison and no `Date.now()` in these pages.

**A workflow that becomes blocked after creation** (classification raised, folder archived or trashed) is **omitted from the list entirely**, and direct access to its detail fails with the same "not found" the portal uses for a request belonging to someone else or one that never existed. The three are deliberately indistinguishable: a stale request must not become a side channel confirming that a document exists or that its classification changed. The workflow row is retained internally as evidence — it is simply invisible to the assignee.

## 12. Controlled submission (F26-D)

`POST /api/portal/workflows/:id/submissions`, multipart, external accounts only.

**The destination is pinned server-side.** The client sends the workflow id in the path and the file — nothing else. The target folder is read from the request row. Any field that looks like an attempt to steer the destination (`parentId`, `folderId`, `destinationResourceId`, `targetResourceId`, `resourceId`) causes the **whole request to be rejected** rather than silently ignored. Ignoring it would let a caller believe their instruction took effect, and eventually something would be built on that false belief.

**The upload path is the ordinary one.** Submission delegates to `uploadToPortalFolder`, so checksums, MIME and size validation, name-conflict rules (`KEEP_BOTH` — nothing is ever overwritten), the storage-provider abstraction, version invariants and the existing `EXTERNAL_FILE_UPLOADED` audit event all apply unchanged. No second file path exists.

**Ownership follows the existing meaning of `ownerId`: the responsible internal person, not the uploader.** A submitted file inherits the target folder's owner and records `createdById` as the external submitter, exactly as portal uploads already did. Making the customer the owner would misread the field and hand document responsibility outside the company.

**The link is stored, never inferred.** `ExternalWorkflowSubmission` binds request → resource → submitter → sequence. Recovering that association later from folder contents, filenames, creator or timestamps would be guesswork, and guessing wrong about which file answered which request corrupts the evidence the workflow exists to produce.

### Who may submit, and when

| Condition | Result |
|---|---|
| status `OPEN` and `allowUpload: true` | accepted |
| status `SUBMITTED`/`UNDER_REVIEW`/`REVISION_REQUESTED`/`APPROVED`/`REJECTED`/`REVOKED` | `WORKFLOW_NOT_SUBMITTABLE` |
| expired | `WORKFLOW_NOT_SUBMITTABLE` |
| `allowUpload: false` | `WORKFLOW_UPLOAD_NOT_ALLOWED` |
| target blocked or not the caller's request | `WORKFLOW_NOT_FOUND` |

`REVISION_REQUESTED` is deliberately **not** submittable yet: resubmission means deciding how prior versions and reviewer history are preserved, which F26-F owns. Opening it early would produce behaviour nobody specified.

**Task permission is not space permission.** Submission requires `workflow.allowUpload`, read from the request — never inferred from the assignee's effective folder capability. Otherwise a manual `EDITOR` grant would silently convert a read-only task into an uploadable one, against the intent of whoever issued it. Tested explicitly with a manual EDITOR grant present.

**`allowDownload`** keeps the overlay semantics from B1: it can add download capability for the duration of the task and never subtracts standing rights. Submitters can retrieve their own submission only if their ordinary effective portal permission allows it; no special-case bypass was invented for "your own file".

### Ordering, races and compensation

1. Check policy (before accepting bytes).
2. Upload through the normal pipeline.
3. **Re-check policy.** A request can expire, be revoked, or have its folder reclassified while the file is still streaming; validating only at the start leaves a window.
4. Bind in one transaction: a compare-and-swap `OPEN → SUBMITTED` plus the submission row plus the audit event.
5. On any failure after step 2, delete the resource **and its bytes**.

Step 4 is what picks a winner when two uploads race: `updateMany({ where: { state: 'OPEN' } })` succeeds for exactly one caller. The loser gets `WORKFLOW_ALREADY_SUBMITTED` and is compensated — no row, no bytes. This is enforced by the database, not by disabling a button. Both the race and a mid-flight classification change are covered by tests that assert the orphan count is unchanged afterwards.

**Access review is unaffected.** Submitting creates no `ResourceAccess` row and no new permission path; the review still explains the assignee's access as `WORKFLOW` evidence alone.

## 13. Mobile behaviour

The portal gained a bottom navigation bar below `sm`, respecting `env(safe-area-inset-bottom)`, because the top-right corner of a phone is outside thumb reach. Cards are full-width tap targets at `min-h-11`; every button meets the same minimum. **No action is hidden behind hover** — there is no hover on touch.

Offline, submission is disabled with a plain statement that the file will **not** be sent automatically later. Consistent with F24: a file parked in a web page disappears when the tab closes, so promising delivery would be a promise the system cannot keep. There is no retry queue and no background sync. The UI never claims success before the server confirms — there is no optimistic update, and the success path refetches real state.

## 14. Review (F26-E)

**Who may review:** whoever can manage sharing on the target folder — the same `assertMayManageAccess` gate used by sharing and by request creation, not merely "any internal user". Approving work means vouching for a document entering that folder; someone who cannot share the folder should not decide what passes into it. The gate covers visibility and scope together, so cross-scope access fails as a side effect rather than needing its own check.

**Every transition is a compare-and-swap** inside one transaction with its audit row. Read-then-write would let two reviewers both pass the check and the later writer win silently. The loser of a race gets an explicit `WORKFLOW_STATE_CONFLICT` or `WORKFLOW_INVALID_TRANSITION`, never an ambiguous outcome.

**Stale-submission protection.** Review actions carry the `submissionId` the reviewer was looking at. If a newer revision has arrived, the action fails with `WORKFLOW_REVIEW_STALE` rather than recording an approval of something the approver never saw. State CAS alone is insufficient here: a reviewer whose screen showed revision #1 can act while #2 is current, with the state still `SUBMITTED` both times.

**Reasons.** Approval needs none — accepting work does not require justification. Rejection, revision and revocation each require a trimmed reason of at least 10 characters (max 500). Whitespace-only and `.` are rejected; a mandatory field that accepts a dot is not mandatory.

## 15. Revision and resubmission (F26-F)

`REVISION_REQUESTED` reopens submission through the **same endpoint** — `OPEN` means first submission, `REVISION_REQUESTED` means a revision, and every other state refuses.

**Each resubmission creates a new Resource, not a new version of the old one.** This was chosen after auditing both options. The portal has no version-upload path for external users at all, and `canSeeVersionHistory` is false for them (§16) — so versions created by a submitter would be invisible to that submitter, which is incoherent. `KEEP_BOTH` already guarantees nothing is overwritten, each submission stays a distinct durable document, and F26-D's `@@unique([resourceId])` on submissions continues to hold. Historical evidence is reconstructable by construction: separate rows, separate files, separate bytes.

**Current submission = highest `sequence`.** No mutable `currentSubmissionId` is stored anywhere. Two places claiming to know "which one is latest" will disagree the day one of them is not updated, and a reviewer would then judge the wrong revision without anyone noticing.

Two simultaneous resubmissions resolve to exactly one: the state CAS picks a winner, and `@@unique([workflowRequestId, sequence])` is the second guarantee underneath it. The loser leaves no row and no bytes.

## 16. Generic version history is closed for external users

`externalCapabilities` declared `canSeeVersionHistory: false` from the beginning, explicitly marked as a decision rather than an oversight — but the portal version routes never consulted it, so customers could list, open and download the full version history of internal documents. That exposed internal working rhythm (how many revisions, when, by whom) that has nothing to do with the customer's own work.

**This is now enforced.** `GET /portal/resources/:id/versions` and both version content/download routes answer with the portal's ordinary "not found", which does not confirm that a history exists. The current version remains fully viewable and downloadable under existing permissions — what closed is the *history*, not the document.

**This removed behaviour that earlier phases deliberately built and tested.** Four F18-era tests asserted the opposite and were replaced, not deleted quietly. The customer's own submission history is unaffected: it lives on the workflow detail screen and shows only what that customer sent.

## 17. Revocation and expiry (F26-G)

Revocation is a state transition and nothing else. It does **not** call `revokeAccess`, does not delete the workflow row, the submission rows, the submitted files, or any `ResourceAccess`. Access stops because `REVOKED` is not in `ACCESS_CONTRIBUTING_STATES`; the evidence survives intact.

`EXPIRED` stays derived from `expiresAt` on every read — list, detail, content, download, submission, resubmission, review and the access merge all re-evaluate against the current time. No cron, no cached permission. A revoked-and-expired request still reports `REVOKED`, because a human decision should not be masked by the passage of time.

Revoking an already-expired request is permitted and meaningful: it records that the work ended by cancellation rather than by lapsing, which is a different fact to an auditor. Every other transition on an expired request is refused.

### Access contribution by state

| State | Workflow grant contributes |
|---|---|
| `OPEN` · `SUBMITTED` · `UNDER_REVIEW` · `REVISION_REQUESTED` | **yes** |
| `APPROVED` · `REJECTED` · `REVOKED` · expired | **no** |

`SUBMITTED` and `UNDER_REVIEW` still grant access deliberately: cutting access the instant someone presses send would make their work appear to vanish while it is merely being reviewed.

**Manual grants are untouched by all four endings** — level, download flag and expiry all survive approval, rejection, revocation and expiry, and the manual portion of access keeps working afterwards. Re-proven directly against every ending.

**The classification and lifecycle ceiling still outranks every state.** CONFIDENTIAL, RESTRICTED, archived and trashed each block external access in every workflow state, and no transition can override that.

## 18. Compensation after a failed upload bind

F26-D's cleanup was best-effort: if deleting the bytes itself failed, the error was logged and forgotten once the log rotated.

**Mitigated, not eliminated.** A failed compensation now also writes a durable `STORAGE_CLEANUP_FAILED` audit row carrying the orphaned resource id, the workflow, and the stage — so the bytes remain findable and recoverable, and `auditStorage` (which already scans for `ORPHAN_OBJECT`) has a reference point for where they came from. No job queue or automatic retry was added: retrying while storage is down fails the same way, and the gap was visibility, not attempts. **If storage is unavailable during compensation, orphan bytes can still be created** — that risk is real and is now observable instead of silent.

## 19. Known limitations

- Revision rounds are unbounded — nothing caps how many times work can cycle between `REVISION_REQUESTED` and `SUBMITTED`.
- The submitted file is visible to the assignee only through ordinary portal permissions; there is no workflow-specific download route.
- Compensation is mitigated, not solved (§18): a storage outage during cleanup still leaves orphan bytes, now recorded rather than silent.
- Reviewers cannot add a comment without also making a decision; there is no discussion thread.
- The workflow history endpoint filters audit rows in memory over the most recent 500 governance events, which is fine at current volume but will need a query-side filter if workflow activity grows large.
- The permissive merge is deliberate (§7), but it means an administrator cannot use a workflow to *narrow* someone's standing access — narrowing is done by editing the manual grant.
- `listPortalRoots` issues one extra lookup for folders reachable only through a workflow. Fine at current scale; worth folding into a single query if an assignee ever holds hundreds of requests.
- Folder-only targets.
- No notifications — the backend has no mail, push or webhook infrastructure, and F26 does not add one.
- `canSeeVersionHistory: false` is still declared but not enforced by `listPortalVersions` (carried from F26-A, deferred to F26-F).
- The assignee list caps at 200 requests with no pagination.
