-- CreateTable
CREATE TABLE `google_drive_connections` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `providerSubject` VARCHAR(191) NOT NULL,
    `googleAccountEmail` VARCHAR(191) NOT NULL,
    `accessTokenEncrypted` TEXT NULL,
    `refreshTokenEncrypted` TEXT NULL,
    `tokenExpiresAt` DATETIME(3) NULL,
    `scope` VARCHAR(500) NULL,
    `state` ENUM('ACTIVE', 'REAUTH_REQUIRED', 'CREDENTIAL_UNREADABLE', 'DISCONNECTED') NOT NULL DEFAULT 'ACTIVE',
    `connectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSuccessfulSyncAt` DATETIME(3) NULL,
    `lastErrorCode` VARCHAR(64) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `google_drive_connections_userId_idx`(`userId`),
    INDEX `google_drive_connections_providerSubject_idx`(`providerSubject`),
    INDEX `google_drive_connections_state_idx`(`state`),
    UNIQUE INDEX `google_drive_connections_userId_providerSubject_key`(`userId`, `providerSubject`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `google_drive_syncs` (
    `id` VARCHAR(191) NOT NULL,
    `connectionId` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `googleFileId` VARCHAR(191) NOT NULL,
    `mode` ENUM('IMPORT_ONCE', 'SYNCED') NOT NULL DEFAULT 'SYNCED',
    `remoteName` VARCHAR(191) NULL,
    `remoteMimeType` VARCHAR(191) NULL,
    `remoteWebUrl` TEXT NULL,
    `lastRemoteModifiedTime` DATETIME(3) NULL,
    `lastRemoteVersion` VARCHAR(64) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `syncEnabled` BOOLEAN NOT NULL DEFAULT true,
    `detachedAt` DATETIME(3) NULL,
    `lastIssue` ENUM('SOURCE_MISSING', 'PERMISSION_LOST', 'AUTH_REQUIRED', 'UNSUPPORTED', 'TRANSIENT') NULL,
    `lastErrorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `google_drive_syncs_resourceId_idx`(`resourceId`),
    INDEX `google_drive_syncs_connectionId_idx`(`connectionId`),
    INDEX `google_drive_syncs_syncEnabled_lastCheckedAt_idx`(`syncEnabled`, `lastCheckedAt`),
    UNIQUE INDEX `google_drive_syncs_connectionId_googleFileId_key`(`connectionId`, `googleFileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `google_drive_connections` ADD CONSTRAINT `google_drive_connections_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `google_drive_syncs` ADD CONSTRAINT `google_drive_syncs_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `google_drive_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `google_drive_syncs` ADD CONSTRAINT `google_drive_syncs_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

