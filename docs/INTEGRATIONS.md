# Connected Apps

Connected Apps let trusted internal systems create and retrieve S2 NAS resources without using a human session. An app is an independent identity with an `ACTIVE` or `DISABLED` state, an allowed root folder, least-privilege scopes, and revocable credentials.

SUPER_ADMIN users manage apps at `/admin/integrations`. Credentials are shown once when created. After the dialog closes, only safe metadata remains retrievable. Disabling an app or revoking a credential takes effect on the next request.

Each app has a dedicated `SERVICE` user for compatibility with existing ownership and file-pipeline checks. It never receives SUPER_ADMIN. Resources, versions, and activity records also store the explicit app identity, so the UI renders the app rather than a human administrator.

Integration resources can store `sourceSystem`, `sourceEntityType`, `sourceEntityId`, and a validated HTTP(S) `sourceUrl`. The server derives `sourceType` from the app code (`S2_PAYROLL`, `S2_ERP`, `S2_LINE_BOT`, or `EXTERNAL_UPLOAD`); clients cannot select it.

Example flows: Payroll uploads a payslip and stores the returned NAS ID; ERP uploads a receipt or document link without direct NAS database access; a LINE bot uploads evidence and stores the returned ID in its own system.

F3 provides the foundation only. It does not add Google OAuth or sync, OCR/AI, public sharing, or a backup scheduler, and it does not modify Payroll, ERP, or LINE projects.
