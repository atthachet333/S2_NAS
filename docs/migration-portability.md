# Migration portability

Prisma applies migration directories in lexicographic name order. Migration
timestamps must therefore reflect dependency order: a later feature must never
sort before a migration containing a table, column, index, or enum it uses.

## Legacy F3 ordering repair

`20260902092500_phase_f3_connected_apps_integrations` alters
`resource_versions`, but the original table creation was placed in the later
`20260902120000_phase_d_file_versions_visibility_trash` migration. The
`20260902092400_phase_f3_resource_versions_prerequisite` migration creates the
base table immediately before F3. Phase D retains its original name and uses
`CREATE TABLE IF NOT EXISTS`, then completes its resource columns and foreign
keys.

The F3 migration was not renamed or edited, preserving its name and checksum for
databases that already record it. The Phase D checksum changed by the addition
of the idempotency guard; deployed databases do not replay a completed Phase D.

## Smoke check

Use either a separately provisioned empty database whose name starts with
`s2_nas_migration_smoke_`:

```sh
cd backend
MIGRATION_SMOKE_DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/s2_nas_migration_smoke_local" npm run prisma:smoke
```

or provide an administrative connection that may create and drop databases:

```sh
cd backend
MIGRATION_SMOKE_ADMIN_URL="mysql://ADMIN:PASSWORD@HOST:3306/mysql" npm run prisma:smoke
```

PowerShell equivalents set the environment variable first:

```powershell
$env:MIGRATION_SMOKE_DATABASE_URL = "mysql://USER:PASSWORD@HOST:3306/s2_nas_migration_smoke_local"
npm run prisma:smoke
```

The command deploys every migration, checks migration status, and checks schema
drift against `prisma/schema.prisma`. When the script creates the database
through `MIGRATION_SMOKE_ADMIN_URL`, it drops only the generated,
prefix-validated database in a `finally` block. A supplied database is retained
for its owner to remove.
