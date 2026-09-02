CREATE TABLE `users` (
  `id` VARCHAR(191) NOT NULL, `email` VARCHAR(191) NOT NULL,
  `displayName` VARCHAR(191) NOT NULL, `passwordHash` VARCHAR(191) NULL,
  `type` ENUM('HUMAN','SERVICE') NOT NULL DEFAULT 'HUMAN',
  `status` ENUM('INVITED','ACTIVE','SUSPENDED','DISABLED') NOT NULL DEFAULT 'INVITED',
  `mustChangePassword` BOOLEAN NOT NULL DEFAULT true, `tokenVersion` INTEGER NOT NULL DEFAULT 0,
  `lastLoginAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL, UNIQUE INDEX `users_email_key`(`email`),
  INDEX `users_status_idx`(`status`), INDEX `users_createdAt_idx`(`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `roles` (
  `id` VARCHAR(191) NOT NULL, `code` VARCHAR(64) NOT NULL, `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(500) NULL, `isSystem` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `roles_code_key`(`code`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `permissions` (
  `id` VARCHAR(191) NOT NULL, `code` VARCHAR(100) NOT NULL, `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(500) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `permissions_code_key`(`code`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_roles` (
  `userId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `user_roles_roleId_idx`(`roleId`), PRIMARY KEY (`userId`,`roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `role_permissions` (
  `roleId` VARCHAR(191) NOT NULL, `permissionId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `role_permissions_permissionId_idx`(`permissionId`), PRIMARY KEY (`roleId`,`permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `refresh_tokens` (
  `id` VARCHAR(191) NOT NULL, `tokenHash` CHAR(64) NOT NULL, `userId` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL, `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `refresh_tokens_tokenHash_key`(`tokenHash`),
  INDEX `refresh_tokens_userId_expiresAt_idx`(`userId`,`expiresAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `activity_logs` (
  `id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `action` VARCHAR(100) NOT NULL,
  `resourceId` VARCHAR(191) NULL, `ipAddress` VARCHAR(64) NULL, `userAgent` VARCHAR(500) NULL,
  `metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `activity_logs_createdAt_idx`(`createdAt`),
  INDEX `activity_logs_userId_createdAt_idx`(`userId`,`createdAt`),
  INDEX `activity_logs_resourceId_createdAt_idx`(`resourceId`,`createdAt`),
  INDEX `activity_logs_action_createdAt_idx`(`action`,`createdAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_settings` (
  `id` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, `value` TEXT NOT NULL,
  `description` VARCHAR(500) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL, UNIQUE INDEX `system_settings_key_key`(`key`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `activity_logs` ADD CONSTRAINT `activity_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
