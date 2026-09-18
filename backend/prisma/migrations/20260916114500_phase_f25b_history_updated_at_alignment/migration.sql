-- Align the database column with Prisma's @updatedAt contract.
-- The first F25-B migration used a database default while the datamodel intentionally
-- lets Prisma supply and update this value. Keep the correction forward-only because
-- the first migration has already been applied to the live database.
ALTER TABLE `legal_hold_history`
    ALTER COLUMN `updatedAt` DROP DEFAULT;
