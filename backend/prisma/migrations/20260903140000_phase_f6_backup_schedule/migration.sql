-- AlterTable
ALTER TABLE `backup_logs` ADD COLUMN `offsiteAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `offsiteErrorSafe` VARCHAR(500) NULL,
    ADD COLUMN `offsiteState` ENUM('NOT_CONFIGURED', 'PENDING', 'COPYING', 'VERIFIED', 'FAILED') NOT NULL DEFAULT 'NOT_CONFIGURED',
    ADD COLUMN `offsiteVerifiedAt` DATETIME(3) NULL,
    ADD COLUMN `trigger` ENUM('MANUAL', 'SCHEDULED') NOT NULL DEFAULT 'MANUAL';

-- CreateIndex
CREATE INDEX `backup_logs_trigger_status_startedAt_idx` ON `backup_logs`(`trigger`, `status`, `startedAt`);

-- CreateIndex
CREATE INDEX `backup_logs_offsiteState_idx` ON `backup_logs`(`offsiteState`);

