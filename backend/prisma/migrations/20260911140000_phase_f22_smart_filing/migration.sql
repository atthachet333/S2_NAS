-- CreateTable
CREATE TABLE `smart_filing_suggestions` (
    `id` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `resourceVersionId` VARCHAR(191) NOT NULL,
    `analyzedById` VARCHAR(191) NOT NULL,
    `status` ENUM('READY', 'ACCEPTED', 'DISMISSED', 'STALE', 'FAILED') NOT NULL DEFAULT 'READY',
    `resultLevel` ENUM('CLIENT_ONLY', 'CLIENT_AND_PERIOD', 'FULL_DESTINATION', 'AMBIGUOUS', 'NO_SUGGESTION') NOT NULL,
    `clientRootFolderId` VARCHAR(191) NULL,
    `suggestedFolderId` VARCHAR(191) NULL,
    `clientConfidence` ENUM('HIGH', 'MEDIUM', 'LOW') NULL,
    `destinationConfidence` ENUM('HIGH', 'MEDIUM', 'LOW') NULL,
    `suggestedCompanyLabel` VARCHAR(191) NULL,
    `suggestedCategory` VARCHAR(64) NULL,
    `suggestedYear` INTEGER NULL,
    `reasonJson` JSON NULL,
    `signalJson` JSON NULL,
    `analyzerVersion` VARCHAR(32) NOT NULL,
    `failureCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `dismissedAt` DATETIME(3) NULL,
    `staleAt` DATETIME(3) NULL,

    INDEX `smart_filing_suggestions_resourceId_status_idx`(`resourceId`, `status`),
    INDEX `smart_filing_suggestions_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `smart_filing_suggestions_resourceId_resourceVersionId_analyz_key`(`resourceId`, `resourceVersionId`, `analyzedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `smart_filing_suggestions` ADD CONSTRAINT `smart_filing_suggestions_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `smart_filing_suggestions` ADD CONSTRAINT `smart_filing_suggestions_analyzedById_fkey` FOREIGN KEY (`analyzedById`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

