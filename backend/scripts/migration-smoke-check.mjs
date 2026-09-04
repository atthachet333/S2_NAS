import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const sourceUrl = process.env.DATABASE_URL;
const suppliedSmokeUrl = process.env.MIGRATION_SMOKE_DATABASE_URL;
const adminUrl = process.env.MIGRATION_SMOKE_ADMIN_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const databaseName = suppliedSmokeUrl
  ? new URL(suppliedSmokeUrl).pathname.slice(1)
  : `s2_nas_migration_smoke_${crypto.randomBytes(6).toString("hex")}`;
const disposableUrl = suppliedSmokeUrl ? new URL(suppliedSmokeUrl) : new URL(sourceUrl);
disposableUrl.pathname = `/${databaseName}`;

// Some deployments only grant the app account CREATE on the "test_" namespace,
// so a disposable database there is allowed too. Both prefixes are unmistakably throwaway.
if (!/^(test_)?s2_nas_migration_smoke_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Smoke database name must start with s2_nas_migration_smoke_ or test_s2_nas_migration_smoke_");
}
if (disposableUrl.toString() === new URL(sourceUrl).toString()) {
  throw new Error("Refusing to use DATABASE_URL itself as the disposable database");
}
if (!suppliedSmokeUrl && !adminUrl) {
  throw new Error("Set MIGRATION_SMOKE_DATABASE_URL, or MIGRATION_SMOKE_ADMIN_URL to create one");
}

const admin = adminUrl
  ? new PrismaClient({ datasources: { db: { url: adminUrl } } })
  : null;
const smoke = new PrismaClient({ datasources: { db: { url: disposableUrl.toString() } } });
let createdDatabase = false;

/** Prisma CLI entrypoint resolved from this package, not from PATH */
const prismaEntrypoint = path.join(
  path.dirname(createRequire(import.meta.url).resolve("prisma/package.json")),
  "build",
  "index.js",
);

function prisma(args) {
  // Run Prisma's JS entrypoint with the current Node binary rather than the npx
  // shim. Node refuses to spawn .cmd files directly on Windows since the 2024
  // command-injection fix, and using `shell: true` instead would place the
  // database URL - password included - on a shell command line where other
  // processes can read it. This avoids both problems.
  const result = spawnSync(
    process.execPath,
    [prismaEntrypoint, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: disposableUrl.toString() },
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  // spawnSync leaves stdout/stderr undefined when the process could not be launched
  // at all (missing binary, blocked exec). Writing undefined throws and hides the
  // real cause, so surface the launch failure instead.
  if (result.error) {
    process.stderr.write(`Failed to run npx prisma ${args.join(" ")}: ${result.error.message}\n`);
    process.exitCode = 1;
    return { ...result, status: 1 };
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result;
}

try {
  if (admin) {
    await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    createdDatabase = true;
  } else {
    const tables = await smoke.$queryRawUnsafe(
      "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
    );
    if (Number(tables[0].count) !== 0) throw new Error("Smoke database is not empty");
  }

  if (prisma(["migrate", "deploy"]).status !== 0) throw new Error("Migration deploy failed");
  if (prisma(["migrate", "status"]).status !== 0) throw new Error("Migration status failed");

  const diff = prisma([
    "migrate",
    "diff",
    "--from-url",
    disposableUrl.toString(),
    "--to-schema-datamodel",
    "prisma/schema.prisma",
    "--exit-code",
  ]);
  if (diff.status !== 0) throw new Error("Schema drift detected");

  console.log(`Migration smoke check passed for disposable database ${databaseName}.`);
} finally {
  await smoke.$disconnect();
  if (admin && createdDatabase) {
    await admin.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
  }
  await admin?.$disconnect();
}
