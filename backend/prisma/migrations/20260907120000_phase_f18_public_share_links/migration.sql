-- CreateTable
CREATE TABLE `public_share_links` (
    `id` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `allowPreview` BOOLEAN NOT NULL DEFAULT true,
    `allowDownload` BOOLEAN NOT NULL DEFAULT false,
    `passwordHash` VARCHAR(191) NULL,
    `maxViews` INTEGER NULL,
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `maxDownloads` INTEGER NULL,
    `downloadCount` INTEGER NOT NULL DEFAULT 0,
    `revokedAt` DATETIME(3) NULL,
    `revokedById` VARCHAR(191) NULL,
    `lastAccessedAt` DATETIME(3) NULL,

    UNIQUE INDEX `public_share_links_tokenHash_key`(`tokenHash`),
    INDEX `public_share_links_resourceId_idx`(`resourceId`),
    INDEX `public_share_links_createdById_idx`(`createdById`),
    INDEX `public_share_links_expiresAt_idx`(`expiresAt`),
    INDEX `public_share_links_revokedAt_idx`(`revokedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `public_share_links` ADD CONSTRAINT `public_share_links_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `public_share_links` ADD CONSTRAINT `public_share_links_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `public_share_links` ADD CONSTRAINT `public_share_links_revokedById_fkey` FOREIGN KEY (`revokedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

