-- System Drive: ไดร์ฟกลางขององค์กรหนึ่งเดียว แยกจากไดร์ฟของฉัน
--
-- ทรัพยากรเดิมทั้งหมดอยู่ในไดร์ฟของฉัน จึงตั้งค่าเริ่มต้นเป็น MY_DRIVE
-- ไม่มีการทำสำเนาทรัพยากรหรือสร้างต้นไม้ซ้ำ - แยกด้วยคอลัมน์เดียวที่สืบทอดจากโฟลเดอร์แม่

ALTER TABLE `resources`
  ADD COLUMN `driveScope` ENUM('MY_DRIVE', 'SYSTEM_DRIVE') NOT NULL DEFAULT 'MY_DRIVE';

CREATE INDEX `resources_driveScope_idx` ON `resources`(`driveScope`);
CREATE INDEX `resources_driveScope_parentId_deletedAt_idx` ON `resources`(`driveScope`, `parentId`, `deletedAt`);

-- siblingKey ของรายการระดับบนสุดเดิมคือ 'ROOT:<ชื่อ>' ซึ่งจะชนกันทันทีที่มีสองไดร์ฟ
-- (เช่น "Templates" ที่รากของทั้งสองไดร์ฟ) จึงผูกไดร์ฟเข้าไปในคีย์ของรายการระดับราก
--
-- รายการที่อยู่ในถังขยะใช้คีย์รูปแบบ 'TRASH:<id>' และ 'deleted:<id>' อยู่แล้ว
-- เงื่อนไข LIKE 'ROOT:%' จึงไม่แตะรายการเหล่านั้น
UPDATE `resources`
   SET `siblingKey` = CONCAT('MY_DRIVE:ROOT:', `normalizedName`)
 WHERE `parentId` IS NULL
   AND `siblingKey` LIKE 'ROOT:%';
