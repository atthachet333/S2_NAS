-- F15: ประเภทเอกสาร ชุดค้นหาที่บันทึกไว้ และสถานะการตรวจผลของ OCR
--
-- ทุกอย่างเป็นการ "เพิ่ม" ล้วน ไม่มีการเปลี่ยนหรือลบคอลัมน์เดิม
--
-- reviewStatus แยกจาก SearchIndexStatus โดยตั้งใจ เพราะตอบคนละคำถาม:
--   SearchIndexStatus = เครื่องอ่านสำเร็จหรือไม่
--   reviewStatus      = มีคนดูผลนั้นแล้วหรือยัง

-- AlterTable
ALTER TABLE `resource_search_index` ADD COLUMN `reviewStatus` ENUM('UNREVIEWED', 'VERIFIED', 'CORRECTED') NOT NULL DEFAULT 'UNREVIEWED',
    ADD COLUMN `reviewedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewedById` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `resources` ADD COLUMN `documentCategoryId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `document_categories` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `document_categories_slug_key`(`slug`),
    INDEX `document_categories_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `saved_searches` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `query` VARCHAR(191) NOT NULL DEFAULT '',
    `filters` JSON NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `saved_searches_userId_lastUsedAt_idx`(`userId`, `lastUsedAt`),
    UNIQUE INDEX `saved_searches_userId_name_key`(`userId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `resource_search_index_reviewStatus_textSource_createdAt_idx` ON `resource_search_index`(`reviewStatus`, `textSource`, `createdAt`);

-- AddForeignKey
ALTER TABLE `resources` ADD CONSTRAINT `resources_documentCategoryId_fkey` FOREIGN KEY (`documentCategoryId`) REFERENCES `document_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_search_index` ADD CONSTRAINT `resource_search_index_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_categories` ADD CONSTRAINT `document_categories_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `saved_searches` ADD CONSTRAINT `saved_searches_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: เอกสารที่ถูกตรวจแก้ไปแล้วใน F14 ถือว่าผ่านการตรวจโดยมนุษย์แล้ว
--
-- ถ้าไม่ทำขั้นตอนนี้ เอกสารที่มีคนนั่งแก้ไปแล้วจะกลับเข้าคิว "ยังไม่ตรวจ" อีกครั้ง
-- ซึ่งทำให้คิวโกหก และทำให้คนเสียเวลาตรวจงานที่ตัวเองทำไปแล้ว
UPDATE `resource_search_index`
SET `reviewStatus` = 'CORRECTED',
    `reviewedById` = `correctedById`,
    `reviewedAt`   = `correctedAt`
WHERE `textSource` = 'HUMAN_CORRECTED';
