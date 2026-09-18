-- F25-B: durable Legal Hold evidence independent from Resource lifetime.
--
-- This is additive. Existing legal_holds rows are copied with their current resource snapshot.
-- No resource, hold, retention assignment, or activity row is changed or removed.

CREATE TABLE `legal_hold_history` (
    `id` VARCHAR(191) NOT NULL,
    `legalHoldId` VARCHAR(191) NOT NULL,
    `originalResourceId` VARCHAR(191) NOT NULL,
    `resourceName` VARCHAR(191) NOT NULL,
    `resourceType` ENUM('FILE', 'FOLDER', 'GOOGLE_SHEET', 'GOOGLE_DOC', 'GOOGLE_DRIVE', 'WEB_LINK', 'SYSTEM_FILE', 'SHORTCUT') NOT NULL,
    `driveScope` ENUM('MY_DRIVE', 'SYSTEM_DRIVE') NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `caseReference` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `releaseReason` VARCHAR(500) NULL,
    `releasedById` VARCHAR(191) NULL,
    `releasedAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `legal_hold_history_legalHoldId_key`(`legalHoldId`),
    INDEX `legal_hold_history_originalResourceId_createdAt_idx`(`originalResourceId`, `createdAt`),
    INDEX `legal_hold_history_isActive_createdAt_idx`(`isActive`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `legal_hold_history` (
    `id`, `legalHoldId`, `originalResourceId`, `resourceName`, `resourceType`, `driveScope`,
    `reason`, `caseReference`, `createdById`, `createdAt`, `releaseReason`, `releasedById`,
    `releasedAt`, `isActive`, `updatedAt`
)
SELECT
    CONCAT('lhh_', h.`id`), h.`id`, h.`resourceId`, r.`name`, r.`type`, r.`driveScope`,
    h.`reason`, h.`caseReference`, h.`createdById`, h.`createdAt`, h.`releaseReason`,
    h.`releasedById`, h.`releasedAt`, h.`isActive`, CURRENT_TIMESTAMP(3)
FROM `legal_holds` h
INNER JOIN `resources` r ON r.`id` = h.`resourceId`;

ALTER TABLE `legal_hold_history`
    ADD CONSTRAINT `legal_hold_history_createdById_fkey`
      FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `legal_hold_history_releasedById_fkey`
      FOREIGN KEY (`releasedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
