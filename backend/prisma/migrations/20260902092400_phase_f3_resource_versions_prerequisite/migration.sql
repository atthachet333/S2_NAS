-- Portability prerequisite for the legacy F3 timestamp.
--
-- F3 adds integration metadata to resource_versions, while the original Phase D
-- migration that creates this table sorts after F3. Keep this definition aligned
-- with the base ResourceVersion shape in Phase D. Phase D uses IF NOT EXISTS so
-- it remains safe after this prerequisite.
CREATE TABLE IF NOT EXISTS `resource_versions` (
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
