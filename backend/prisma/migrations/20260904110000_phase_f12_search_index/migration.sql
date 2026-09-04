-- Phase F12 - ดัชนีข้อความในเอกสาร เพื่อให้ค้นหาจากเนื้อในไฟล์ได้
--
-- หนึ่งแถวต่อหนึ่งเวอร์ชันของไฟล์ งานสกัดจึงทำซ้ำได้โดยไม่เกิดผลข้างเคียง
-- และการค้นหาปกติเทียบ versionNumber กับ Resource.currentVersion เสมอ
-- เนื้อหาของเวอร์ชันเก่าจึงไม่มีทางถูกคืนเป็นผลลัพธ์ปัจจุบัน
--
-- ON DELETE CASCADE ทั้งสองทาง: การลบทรัพยากรถาวรหรือการลบเวอร์ชัน
-- ต้องไม่ทิ้งข้อความที่สกัดไว้ค้างอยู่ในฐานข้อมูลโดยไม่มีเจ้าของ

-- AlterTable
ALTER TABLE `activity_logs` MODIFY `metadata` JSON NULL;

-- AlterTable
ALTER TABLE `integration_apps` MODIFY `scopes` JSON NOT NULL;

-- CreateTable
CREATE TABLE `resource_search_index` (
    `id` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `resourceVersionId` VARCHAR(191) NOT NULL,
    `versionNumber` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'READY', 'NO_TEXT', 'UNSUPPORTED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `mimeType` VARCHAR(191) NULL,
    `extractedText` MEDIUMTEXT NULL,
    `normalizedText` MEDIUMTEXT NULL,
    `characterCount` INTEGER NOT NULL DEFAULT 0,
    `truncated` BOOLEAN NOT NULL DEFAULT false,
    `extractedAt` DATETIME(3) NULL,
    `extractorVersion` VARCHAR(32) NOT NULL,
    `errorCode` VARCHAR(100) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `processingStartedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `resource_search_index_resourceVersionId_key`(`resourceVersionId`),
    INDEX `resource_search_index_resourceId_versionNumber_idx`(`resourceId`, `versionNumber`),
    INDEX `resource_search_index_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `resource_search_index_status_processingStartedAt_idx`(`status`, `processingStartedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `resource_search_index` ADD CONSTRAINT `resource_search_index_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_search_index` ADD CONSTRAINT `resource_search_index_resourceVersionId_fkey` FOREIGN KEY (`resourceVersionId`) REFERENCES `resource_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

