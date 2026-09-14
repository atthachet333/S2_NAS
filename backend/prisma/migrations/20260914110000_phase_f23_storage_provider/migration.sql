-- AlterTable
ALTER TABLE `resource_versions` ADD COLUMN `storageProvider` ENUM('LOCAL', 'S3') NOT NULL DEFAULT 'LOCAL';

-- AlterTable
ALTER TABLE `resources` ADD COLUMN `storageProvider` ENUM('LOCAL', 'S3') NOT NULL DEFAULT 'LOCAL';
