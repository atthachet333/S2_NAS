-- F26-D: การส่งงานผ่านคำขอความร่วมมือ
--
-- เพิ่มตารางใหม่หนึ่งตาราง ไม่แก้และไม่ลบอะไรที่มีอยู่เดิม
--
-- ดัชนี unique สองตัวคือกลไกความถูกต้อง ไม่ใช่แค่การกันข้อมูลซ้ำ:
--   (workflowRequestId, sequence) ทำให้การกดส่งพร้อมกันสองครั้งมีผู้ชนะเพียงหนึ่ง
--                                  ที่ระดับฐานข้อมูล ไม่ใช่ที่ปุ่มบนหน้าจอ
--   (resourceId)                   ไฟล์หนึ่งไฟล์ผูกกับการส่งได้ครั้งเดียว
--
-- onDelete: CASCADE ทั้งสองทาง เพราะแถวการส่งที่ชี้ไปยังคำขอหรือไฟล์ที่ถูกลบถาวรแล้ว
-- ไม่มีความหมายเหลืออยู่ ส่วนผู้ส่งเป็น RESTRICT เพื่อไม่ให้หลักฐานว่าใครส่งงานหายไป
--
-- หมายเหตุ: คำสั่ง DROP INDEX ของ semantic_chunks(embedding) ถูกตัดออกโดยตั้งใจ
-- เป็นข้อยกเว้น drift ที่บันทึกไว้ตั้งแต่ F23
-- DropIndex

-- CreateTable
CREATE TABLE `external_workflow_submissions` (
    `id` VARCHAR(191) NOT NULL,
    `workflowRequestId` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `submittedById` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `external_workflow_submissions_workflowRequestId_submittedAt_idx`(`workflowRequestId`, `submittedAt`),
    UNIQUE INDEX `external_workflow_submissions_workflowRequestId_sequence_key`(`workflowRequestId`, `sequence`),
    UNIQUE INDEX `external_workflow_submissions_resourceId_key`(`resourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `external_workflow_submissions` ADD CONSTRAINT `external_workflow_submissions_workflowRequestId_fkey` FOREIGN KEY (`workflowRequestId`) REFERENCES `external_workflow_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `external_workflow_submissions` ADD CONSTRAINT `external_workflow_submissions_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `external_workflow_submissions` ADD CONSTRAINT `external_workflow_submissions_submittedById_fkey` FOREIGN KEY (`submittedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

