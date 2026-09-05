-- F14: การตรวจแก้ข้อความ OCR โดยมนุษย์
--
-- การเปลี่ยน ENUM ครั้งนี้เป็นการ "เพิ่มค่า" ไม่ใช่การเปลี่ยนชื่อค่าเดิม
-- แถวที่เป็น NATIVE_TEXT หรือ OCR อยู่แล้วจึงคงค่าเดิมครบทุกแถว ไม่มีข้อมูลหาย
--
-- rawOcrText เก็บผลดิบของเครื่องไว้ถาวร แยกจาก extractedText ที่เป็น "ข้อความที่มีผลใช้งาน"
-- แถวเดิมก่อน F14 ยังไม่เคยมีใครตรวจแก้ได้ ดังนั้น extractedText ของแถวเหล่านั้น
-- คือผลดิบตามนิยาม จึงคัดลอกมาเป็นค่าตั้งต้นได้อย่างถูกต้อง

-- AlterTable
ALTER TABLE `resource_search_index` ADD COLUMN `correctedAt` DATETIME(3) NULL,
    ADD COLUMN `correctedById` VARCHAR(191) NULL,
    ADD COLUMN `correctionRevision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `rawOcrText` MEDIUMTEXT NULL,
    MODIFY `textSource` ENUM('NATIVE_TEXT', 'OCR', 'HUMAN_CORRECTED') NULL;

-- CreateTable
CREATE TABLE `resource_text_corrections` (
    `id` VARCHAR(191) NOT NULL,
    `resourceSearchIndexId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `text` MEDIUMTEXT NOT NULL,
    `characterCount` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `resource_text_corrections_resourceSearchIndexId_revision_idx`(`resourceSearchIndexId`, `revision`),
    UNIQUE INDEX `resource_text_corrections_resourceSearchIndexId_revision_key`(`resourceSearchIndexId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `resource_search_index` ADD CONSTRAINT `resource_search_index_correctedById_fkey` FOREIGN KEY (`correctedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_text_corrections` ADD CONSTRAINT `resource_text_corrections_resourceSearchIndexId_fkey` FOREIGN KEY (`resourceSearchIndexId`) REFERENCES `resource_search_index`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_text_corrections` ADD CONSTRAINT `resource_text_corrections_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: ผลดิบของแถวเดิม
UPDATE `resource_search_index`
SET `rawOcrText` = `extractedText`
WHERE `textSource` IS NOT NULL AND `extractedText` IS NOT NULL;
