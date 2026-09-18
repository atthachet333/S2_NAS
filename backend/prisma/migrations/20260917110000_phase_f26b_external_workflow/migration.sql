-- F26-B: คำขอความร่วมมือจากภายนอกแบบระบุตัวตน
--
-- เพิ่มตารางใหม่หนึ่งตารางกับ enum หนึ่งตัว ไม่แก้ ไม่ลบ และไม่เขียนทับข้อมูลเดิมใด ๆ
-- ตารางที่มีอยู่ทั้งหมดไม่ถูกแตะเลย มีเพียง foreign key ที่ชี้เข้าหา resources กับ users
--
-- activeSlot เป็นดัชนี unique ที่ยอมรับ null ซ้ำได้ ใช้แทน partial unique index
-- ซึ่ง MySQL/MariaDB ไม่มีให้ใช้ - กันการสร้างคำขอซ้ำที่ระดับฐานข้อมูล ไม่ใช่ที่หน้าจอ
--
-- onDelete: CASCADE ที่ targetResource เพราะคำขอที่ชี้ไปยังเอกสารที่ถูกลบถาวรแล้ว
-- ไม่มีความหมายเหลืออยู่ ส่วนผู้ใช้เป็น RESTRICT เพื่อไม่ให้หลักฐานว่าใครสั่งงานหายไป
--
-- หมายเหตุ: คำสั่ง DROP INDEX ของ semantic_chunks(embedding) ที่ prisma migrate diff
-- สร้างมาให้ถูกตัดออกโดยตั้งใจ ดัชนี VECTOR ของ MariaDB อยู่นอกความสามารถของ
-- Prisma datamodel และเป็นข้อยกเว้น drift ที่บันทึกไว้ตั้งแต่ F23
-- DropIndex

-- CreateTable
CREATE TABLE `external_workflow_requests` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `instructions` VARCHAR(2000) NULL,
    `targetResourceId` VARCHAR(191) NOT NULL,
    `externalUserId` VARCHAR(191) NOT NULL,
    `resourceAccessId` VARCHAR(191) NULL,
    `state` ENUM('OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED') NOT NULL DEFAULT 'OPEN',
    `expiresAt` DATETIME(3) NULL,
    `dueAt` DATETIME(3) NULL,
    `allowUpload` BOOLEAN NOT NULL DEFAULT false,
    `allowDownload` BOOLEAN NOT NULL DEFAULT false,
    `activeSlot` VARCHAR(400) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `external_workflow_requests_activeSlot_key`(`activeSlot`),
    INDEX `external_workflow_requests_externalUserId_state_idx`(`externalUserId`, `state`),
    INDEX `external_workflow_requests_targetResourceId_idx`(`targetResourceId`),
    INDEX `external_workflow_requests_state_expiresAt_idx`(`state`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `external_workflow_requests` ADD CONSTRAINT `external_workflow_requests_targetResourceId_fkey` FOREIGN KEY (`targetResourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `external_workflow_requests` ADD CONSTRAINT `external_workflow_requests_externalUserId_fkey` FOREIGN KEY (`externalUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `external_workflow_requests` ADD CONSTRAINT `external_workflow_requests_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

