-- CreateTable
CREATE TABLE `backup_logs` (
    `id` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `type` ENUM('FULL') NOT NULL DEFAULT 'FULL',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `triggeredByUserId` VARCHAR(191) NULL,
    `databaseBytes` BIGINT NULL,
    `storageBytes` BIGINT NULL,
    `totalBytes` BIGINT NULL,
    `fileCount` INTEGER NULL,
    `backupName` VARCHAR(191) NOT NULL,
    `errorCode` VARCHAR(100) NULL,
    `errorMessageSafe` VARCHAR(500) NULL,
    `manifestChecksum` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `backup_logs_backupName_key`(`backupName`),
    INDEX `backup_logs_status_idx`(`status`),
    INDEX `backup_logs_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `backup_logs` ADD CONSTRAINT `backup_logs_triggeredByUserId_fkey` FOREIGN KEY (`triggeredByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

