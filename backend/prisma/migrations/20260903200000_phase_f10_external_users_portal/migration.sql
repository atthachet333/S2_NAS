-- Phase F10 - ผู้ใช้งานภายนอก (ลูกค้า) + พื้นที่เอกสารสำหรับลูกค้า
--
-- การเปลี่ยนชื่อค่า HUMAN -> INTERNAL ทำเป็นสามขั้นโดยตั้งใจ
-- การสั่ง MODIFY ไปยังชุดค่าใหม่ทันทีจะทำให้ MySQL/MariaDB แปลงค่าเดิมที่ไม่อยู่ในชุดใหม่
-- กลายเป็นค่าว่าง ซึ่งหมายถึงข้อมูลชนิดบัญชีของผู้ใช้ทุกคนหายไปเงียบ ๆ
-- ขั้นตอนนี้จึงเปิดรับค่าใหม่ก่อน ย้ายข้อมูล แล้วจึงปิดค่าเดิม

-- ขั้นที่ 1: เปิดรับทั้งค่าเดิมและค่าใหม่ ยังไม่แตะข้อมูลใด ๆ
ALTER TABLE `users` MODIFY `type` ENUM('HUMAN', 'INTERNAL', 'EXTERNAL', 'SERVICE') NOT NULL DEFAULT 'HUMAN';

-- ขั้นที่ 2: ย้ายความหมายเดิมไปยังชื่อใหม่ - HUMAN คือบุคลากรภายในทั้งหมด
UPDATE `users` SET `type` = 'INTERNAL' WHERE `type` = 'HUMAN';

-- ขั้นที่ 3: ปิดค่าเดิม เหลือเฉพาะชุดค่าที่ใช้จริง
ALTER TABLE `users` MODIFY `type` ENUM('INTERNAL', 'EXTERNAL', 'SERVICE') NOT NULL DEFAULT 'INTERNAL';

-- ชื่อบริษัทของผู้ใช้ภายนอก - ใช้แยกแยะลูกค้าในหน้าจัดการเท่านั้น ไม่ใช่ขอบเขตสิทธิ์
ALTER TABLE `users` ADD COLUMN `organizationName` VARCHAR(191) NULL;

-- วันหมดอายุของการมอบสิทธิ์รายบุคคล - null = ไม่หมดอายุ
ALTER TABLE `resource_access` ADD COLUMN `expiresAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `activity_logs` MODIFY `metadata` JSON NULL;

-- AlterTable
ALTER TABLE `integration_apps` MODIFY `scopes` JSON NOT NULL;

-- CreateIndex
CREATE INDEX `resource_access_userId_expiresAt_idx` ON `resource_access`(`userId`, `expiresAt`);

-- CreateIndex
CREATE INDEX `users_type_status_idx` ON `users`(`type`, `status`);
