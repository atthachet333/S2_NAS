-- AlterTable
ALTER TABLE `resources` ADD COLUMN `currentVersion` INTEGER NULL,
    ADD COLUMN `deletedById` VARCHAR(191) NULL,
    ADD COLUMN `trashedFromId` VARCHAR(191) NULL,
    ADD COLUMN `visibility` ENUM('ORGANIZATION', 'RESTRICTED') NOT NULL DEFAULT 'ORGANIZATION';

-- CreateTable
CREATE TABLE `resource_versions` (
    `id` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `versionNumber` INTEGER NOT NULL,
    `storageKey` VARCHAR(500) NOT NULL,
    `size` BIGINT NOT NULL,
    `checksum` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NULL,
    `remark` VARCHAR(1000) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `resource_versions_storageKey_key`(`storageKey`),
    INDEX `resource_versions_resourceId_idx`(`resourceId`),
    INDEX `resource_versions_checksum_idx`(`checksum`),
    INDEX `resource_versions_createdById_idx`(`createdById`),
    UNIQUE INDEX `resource_versions_resourceId_versionNumber_key`(`resourceId`, `versionNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `resources_checksum_idx` ON `resources`(`checksum`);

-- CreateIndex
CREATE INDEX `resources_visibility_idx` ON `resources`(`visibility`);

-- AddForeignKey
ALTER TABLE `resources` ADD CONSTRAINT `resources_deletedById_fkey` FOREIGN KEY (`deletedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_versions` ADD CONSTRAINT `resource_versions_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_versions` ADD CONSTRAINT `resource_versions_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

