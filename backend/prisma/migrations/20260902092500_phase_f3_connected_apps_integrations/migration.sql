ALTER TABLE `activity_logs` ADD COLUMN `integrationAppId` VARCHAR(191) NULL;
ALTER TABLE `resource_versions` ADD COLUMN `createdByIntegrationAppId` VARCHAR(191) NULL;
ALTER TABLE `resources` ADD COLUMN `createdByIntegrationAppId` VARCHAR(191) NULL,
    ADD COLUMN `sourceEntityId` VARCHAR(191) NULL,
    ADD COLUMN `sourceEntityType` VARCHAR(100) NULL,
    ADD COLUMN `sourceSystem` VARCHAR(100) NULL,
    ADD COLUMN `sourceUrl` TEXT NULL;

CREATE TABLE `integration_apps` (
    `id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `code` VARCHAR(64) NOT NULL,
    `description` VARCHAR(500) NULL, `isActive` BOOLEAN NOT NULL DEFAULT true,
    `actorUserId` VARCHAR(191) NOT NULL, `allowedRootId` VARCHAR(191) NOT NULL,
    `scopes` JSON NOT NULL, `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `integration_apps_code_key`(`code`), UNIQUE INDEX `integration_apps_actorUserId_key`(`actorUserId`),
    INDEX `integration_apps_allowedRootId_idx`(`allowedRootId`), INDEX `integration_apps_isActive_idx`(`isActive`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `integration_credentials` (
    `id` VARCHAR(191) NOT NULL, `appId` VARCHAR(191) NOT NULL, `secretHash` CHAR(64) NOT NULL,
    `label` VARCHAR(191) NULL, `expiresAt` DATETIME(3) NULL, `revokedAt` DATETIME(3) NULL,
    `lastUsedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `integration_credentials_appId_revokedAt_idx`(`appId`, `revokedAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `integration_idempotency` (
    `id` VARCHAR(191) NOT NULL, `appId` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL, `resourceId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `integration_idempotency_resourceId_idx`(`resourceId`),
    UNIQUE INDEX `integration_idempotency_appId_key_key`(`appId`, `key`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `activity_logs_integrationAppId_createdAt_idx` ON `activity_logs`(`integrationAppId`, `createdAt`);
CREATE INDEX `resource_versions_createdByIntegrationAppId_idx` ON `resource_versions`(`createdByIntegrationAppId`);
CREATE INDEX `resources_createdByIntegrationAppId_idx` ON `resources`(`createdByIntegrationAppId`);
CREATE INDEX `resources_sourceSystem_sourceEntityType_sourceEntityId_idx` ON `resources`(`sourceSystem`, `sourceEntityType`, `sourceEntityId`);

ALTER TABLE `resources` ADD CONSTRAINT `resources_createdByIntegrationAppId_fkey` FOREIGN KEY (`createdByIntegrationAppId`) REFERENCES `integration_apps`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `resource_versions` ADD CONSTRAINT `resource_versions_createdByIntegrationAppId_fkey` FOREIGN KEY (`createdByIntegrationAppId`) REFERENCES `integration_apps`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `activity_logs` ADD CONSTRAINT `activity_logs_integrationAppId_fkey` FOREIGN KEY (`integrationAppId`) REFERENCES `integration_apps`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `integration_apps` ADD CONSTRAINT `integration_apps_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `integration_apps` ADD CONSTRAINT `integration_apps_allowedRootId_fkey` FOREIGN KEY (`allowedRootId`) REFERENCES `resources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `integration_credentials` ADD CONSTRAINT `integration_credentials_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `integration_apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `integration_idempotency` ADD CONSTRAINT `integration_idempotency_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `integration_apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `integration_idempotency` ADD CONSTRAINT `integration_idempotency_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
