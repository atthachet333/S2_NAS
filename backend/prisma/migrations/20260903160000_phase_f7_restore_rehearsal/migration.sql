-- CreateTable
CREATE TABLE `restore_rehearsal_logs` (
    `id` VARCHAR(191) NOT NULL,
    `backupId` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'PASSED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `trigger` ENUM('MANUAL', 'SCHEDULED') NOT NULL DEFAULT 'MANUAL',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `databaseRestored` BOOLEAN NOT NULL DEFAULT false,
    `storageRestored` BOOLEAN NOT NULL DEFAULT false,
    `resourceCount` INTEGER NULL,
    `versionCount` INTEGER NULL,
    `missingCount` INTEGER NULL,
    `orphanCount` INTEGER NULL,
    `checksumFailures` INTEGER NULL,
    `cleanupFailed` BOOLEAN NOT NULL DEFAULT false,
    `errorCode` VARCHAR(100) NULL,
    `errorMessageSafe` VARCHAR(500) NULL,
    `triggeredByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `restore_rehearsal_logs_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `restore_rehearsal_logs_backupId_idx`(`backupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `restore_rehearsal_logs` ADD CONSTRAINT `restore_rehearsal_logs_triggeredByUserId_fkey` FOREIGN KEY (`triggeredByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

