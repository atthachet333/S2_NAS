-- Phase F13 - OCR แบบสั่งเอง สำหรับเอกสารสแกน
--
-- ขยายดัชนีเดิมของ F12 แทนการสร้างระบบค้นหาชุดที่สอง
-- งาน OCR อยู่ในคิวเดียวกับการสกัดข้อความปกติ แยกด้วย jobKind
-- จึงใช้กลไกการจองงาน การกู้คืนหลังล่ม และการลองใหม่ ร่วมกันทั้งหมด
--
-- textSource แยก "ข้อความที่ฝังอยู่ในไฟล์จริง" ออกจาก "ข้อความที่เครื่องอ่านจากภาพ"
-- เพราะอย่างหลังเป็นการคาดเดา ผู้ใช้ควรรู้ว่ากำลังเชื่ออะไรอยู่
--
-- แถวเดิมทั้งหมดได้ jobKind = EXTRACT และ ocrRequested = false ตามค่าเริ่มต้น
-- ซึ่งตรงกับความจริง เพราะยังไม่เคยมี OCR ในระบบมาก่อนเฟสนี้

-- AlterTable
ALTER TABLE `activity_logs` MODIFY `metadata` JSON NULL;

-- AlterTable
ALTER TABLE `integration_apps` MODIFY `scopes` JSON NOT NULL;

-- AlterTable
ALTER TABLE `resource_search_index` ADD COLUMN `jobKind` ENUM('EXTRACT', 'OCR') NOT NULL DEFAULT 'EXTRACT',
    ADD COLUMN `ocrCompletedAt` DATETIME(3) NULL,
    ADD COLUMN `ocrConfidence` DOUBLE NULL,
    ADD COLUMN `ocrEngine` VARCHAR(100) NULL,
    ADD COLUMN `ocrLanguages` VARCHAR(64) NULL,
    ADD COLUMN `ocrPageCount` INTEGER NULL,
    ADD COLUMN `ocrRequested` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `textSource` ENUM('NATIVE_TEXT', 'OCR') NULL;

-- CreateIndex
CREATE INDEX `resource_search_index_status_jobKind_createdAt_idx` ON `resource_search_index`(`status`, `jobKind`, `createdAt`);

