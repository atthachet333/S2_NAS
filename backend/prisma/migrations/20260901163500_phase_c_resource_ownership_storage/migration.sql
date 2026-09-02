CREATE TABLE `resources` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('FILE', 'FOLDER', 'GOOGLE_SHEET', 'GOOGLE_DOC', 'GOOGLE_DRIVE', 'WEB_LINK', 'SYSTEM_FILE', 'SHORTCUT') NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `normalizedName` VARCHAR(191) NOT NULL,
    `siblingKey` VARCHAR(500) NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `updatedById` VARCHAR(191) NULL,
    `sourceType` ENUM('MANUAL', 'GOOGLE', 'S2_PAYROLL', 'S2_ERP', 'S2_LINE_BOT', 'EXTERNAL_UPLOAD', 'SYSTEM') NOT NULL DEFAULT 'MANUAL',
    `mimeType` VARCHAR(191) NULL,
    `extension` VARCHAR(32) NULL,
    `size` BIGINT NULL,
    `storageKey` VARCHAR(500) NULL,
    `checksum` VARCHAR(191) NULL,
    `externalUrl` TEXT NULL,
    `externalProvider` VARCHAR(100) NULL,
    `remark` VARCHAR(1000) NULL,
    `isLocked` BOOLEAN NOT NULL DEFAULT false,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `resources_siblingKey_key`(`siblingKey`),
    UNIQUE INDEX `resources_storageKey_key`(`storageKey`),
    INDEX `resources_parentId_idx`(`parentId`),
    INDEX `resources_ownerId_idx`(`ownerId`),
    INDEX `resources_type_idx`(`type`),
    INDEX `resources_sourceType_idx`(`sourceType`),
    INDEX `resources_deletedAt_idx`(`deletedAt`),
    INDEX `resources_updatedAt_idx`(`updatedAt`),
    INDEX `resources_parentId_type_deletedAt_idx`(`parentId`, `type`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `resource_access` (
    `id` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('OWNER', 'EDITOR', 'VIEWER') NOT NULL,
    `allowDownload` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `resource_access_resourceId_idx`(`resourceId`),
    INDEX `resource_access_userId_idx`(`userId`),
    UNIQUE INDEX `resource_access_resourceId_userId_key`(`resourceId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `resources` ADD CONSTRAINT `resources_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `resources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `resources` ADD CONSTRAINT `resources_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `resources` ADD CONSTRAINT `resources_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `resources` ADD CONSTRAINT `resources_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `resource_access` ADD CONSTRAINT `resource_access_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `resource_access` ADD CONSTRAINT `resource_access_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `resource_access` ADD CONSTRAINT `resource_access_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
