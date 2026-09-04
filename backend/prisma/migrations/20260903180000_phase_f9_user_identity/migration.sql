-- CreateTable
CREATE TABLE `user_identities` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` ENUM('GOOGLE') NOT NULL,
    `providerSubject` VARCHAR(191) NOT NULL,
    `providerEmail` VARCHAR(191) NULL,
    `providerEmailNormalized` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastLoginAt` DATETIME(3) NULL,

    INDEX `user_identities_providerEmailNormalized_idx`(`providerEmailNormalized`),
    UNIQUE INDEX `user_identities_provider_providerSubject_key`(`provider`, `providerSubject`),
    UNIQUE INDEX `user_identities_provider_userId_key`(`provider`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_identities` ADD CONSTRAINT `user_identities_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

