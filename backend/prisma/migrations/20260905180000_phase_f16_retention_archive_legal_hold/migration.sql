-- F16: นโยบายการเก็บรักษา คลังเอกสาร และการระงับการลบ
--
-- ทุกอย่างเป็นการ "เพิ่ม" ล้วน ไม่มีการเปลี่ยนหรือลบคอลัมน์เดิม
-- ทรัพยากรเดิมทุกแถวได้ lifecycleState = ACTIVE และไม่มีนโยบายผูกอยู่
-- ซึ่งตรงกับความจริง: ก่อน F16 ไม่มีใครเคยกำหนดนโยบายให้เอกสารใดเลย
--
-- ข้อควรระวัง: lifecycleState แยกจาก deletedAt โดยสิ้นเชิง
-- "เก็บเข้าคลัง" คือการเก็บรักษา ส่วน "ถังขยะ" คือการตั้งใจจะทิ้ง

-- AlterTable
ALTER TABLE `document_categories` ADD COLUMN `defaultRetentionPolicyId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `resources` ADD COLUMN `archivedAt` DATETIME(3) NULL,
    ADD COLUMN `archivedById` VARCHAR(191) NULL,
    ADD COLUMN `lifecycleState` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN `retentionForever` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `retentionPolicyId` VARCHAR(191) NULL,
    ADD COLUMN `retentionStartAt` DATETIME(3) NULL,
    ADD COLUMN `retentionStartBasis` ENUM('CREATED_AT', 'MANUAL') NULL,
    ADD COLUMN `retentionUntil` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `retention_policies` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `retentionDays` INTEGER NULL,
    `retainForever` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `retention_policies_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `legal_holds` (
    `id` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `caseReference` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releaseReason` VARCHAR(500) NULL,
    `releasedById` VARCHAR(191) NULL,
    `releasedAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    INDEX `legal_holds_resourceId_isActive_idx`(`resourceId`, `isActive`),
    INDEX `legal_holds_isActive_createdAt_idx`(`isActive`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `resources_lifecycleState_deletedAt_idx` ON `resources`(`lifecycleState`, `deletedAt`);

-- CreateIndex
CREATE INDEX `resources_retentionUntil_idx` ON `resources`(`retentionUntil`);

-- AddForeignKey
ALTER TABLE `resources` ADD CONSTRAINT `resources_retentionPolicyId_fkey` FOREIGN KEY (`retentionPolicyId`) REFERENCES `retention_policies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resources` ADD CONSTRAINT `resources_archivedById_fkey` FOREIGN KEY (`archivedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_categories` ADD CONSTRAINT `document_categories_defaultRetentionPolicyId_fkey` FOREIGN KEY (`defaultRetentionPolicyId`) REFERENCES `retention_policies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `retention_policies` ADD CONSTRAINT `retention_policies_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `legal_holds` ADD CONSTRAINT `legal_holds_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `legal_holds` ADD CONSTRAINT `legal_holds_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `legal_holds` ADD CONSTRAINT `legal_holds_releasedById_fkey` FOREIGN KEY (`releasedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

