-- F25-D: ระดับชั้นความลับในฐานะ "เพดานการเปิดเผยออกนอกองค์กร"
--
-- เพิ่มอย่างเดียว ไม่แก้ไขหรือลบข้อมูลใด ๆ ที่มีอยู่
--
-- ค่าเริ่มต้นเป็น INTERNAL อย่างจงใจ ไม่ใช่ PUBLIC เพราะ INTERNAL แปลว่า
-- "ห้ามสร้างลิงก์สาธารณะแบบไม่ระบุตัวตน" ซึ่งเป็นสถานะที่ปลอดภัยกว่าเมื่อไม่มีใครตัดสินใจ
-- การตั้งเป็น PUBLIC โดยปริยายจะเท่ากับเปิดเอกสารทั้งคลังให้แชร์ออกนอกได้ทันที
--
-- หมายเหตุ: คำสั่ง DROP INDEX ของ semantic_chunks(embedding) ที่ prisma migrate diff
-- สร้างมาให้ถูกตัดออกโดยตั้งใจ ดัชนี VECTOR ของ MariaDB อยู่นอกความสามารถของ
-- Prisma datamodel และเป็นข้อยกเว้น drift ที่บันทึกไว้ตั้งแต่ F23 การปล่อยให้รัน
-- จะทำลายดัชนีการค้นหาเชิงความหมายของระบบจริง
ALTER TABLE `resources`
    ADD COLUMN `classification` ENUM('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED') NOT NULL DEFAULT 'INTERNAL';

CREATE INDEX `resources_classification_idx` ON `resources`(`classification`);
