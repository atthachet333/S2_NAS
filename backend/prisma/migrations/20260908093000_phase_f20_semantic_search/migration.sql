-- F20 semantic search metadata and MariaDB native vector index.
-- Embeddings are derived data; backup keeps table definitions but excludes their rows.

ALTER TABLE `saved_searches`
  ADD COLUMN `searchMode` ENUM('LEXICAL', 'SEMANTIC', 'HYBRID') NOT NULL DEFAULT 'LEXICAL';

CREATE TABLE `semantic_document_indexes` (
  `id` VARCHAR(191) NOT NULL,
  `resourceId` VARCHAR(191) NOT NULL,
  `resourceVersionId` VARCHAR(191) NOT NULL,
  `versionNumber` INTEGER NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `modelVersion` VARCHAR(191) NOT NULL,
  `effectiveTextFingerprint` CHAR(64) NULL,
  `textSource` ENUM('NATIVE_TEXT', 'OCR', 'HUMAN_CORRECTED') NULL,
  `chunkCount` INTEGER NOT NULL DEFAULT 0,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `processingStartedAt` DATETIME(3) NULL,
  `indexedAt` DATETIME(3) NULL,
  `errorCode` VARCHAR(100) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `semantic_document_indexes_resourceVersionId_key` (`resourceVersionId`),
  INDEX `semantic_document_indexes_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `semantic_document_indexes_status_processingStartedAt_idx` (`status`, `processingStartedAt`),
  INDEX `semantic_document_indexes_resourceId_versionNumber_idx` (`resourceId`, `versionNumber`),
  INDEX `semantic_document_indexes_modelVersion_status_idx` (`modelVersion`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `semantic_chunks` (
  -- Native VECTOR indexes require a primary key of at most 256 bytes.
  `id` CHAR(36) NOT NULL,
  `semanticDocumentIndexId` VARCHAR(191) NOT NULL,
  `resourceId` VARCHAR(191) NOT NULL,
  `resourceVersionId` VARCHAR(191) NOT NULL,
  `chunkIndex` INTEGER NOT NULL,
  `startOffset` INTEGER NOT NULL,
  `endOffset` INTEGER NOT NULL,
  `modelVersion` VARCHAR(191) NOT NULL,
  `embeddingFingerprint` CHAR(64) NOT NULL,
  `textSource` ENUM('NATIVE_TEXT', 'OCR', 'HUMAN_CORRECTED') NOT NULL,
  `embedding` VECTOR(384) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `semantic_chunks_semanticDocumentIndexId_chunkIndex_key` (`semanticDocumentIndexId`, `chunkIndex`),
  INDEX `semantic_chunks_resourceId_resourceVersionId_idx` (`resourceId`, `resourceVersionId`),
  INDEX `semantic_chunks_modelVersion_idx` (`modelVersion`),
  VECTOR INDEX `semantic_chunks_embedding_idx` (`embedding`) M=8 DISTANCE=cosine,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `semantic_document_indexes`
  ADD CONSTRAINT `semantic_document_indexes_resourceId_fkey`
  FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `semantic_document_indexes_resourceVersionId_fkey`
  FOREIGN KEY (`resourceVersionId`) REFERENCES `resource_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `semantic_chunks`
  ADD CONSTRAINT `semantic_chunks_semanticDocumentIndexId_fkey`
  FOREIGN KEY (`semanticDocumentIndexId`) REFERENCES `semantic_document_indexes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `semantic_chunks_resourceId_fkey`
  FOREIGN KEY (`resourceId`) REFERENCES `resources`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `semantic_chunks_resourceVersionId_fkey`
  FOREIGN KEY (`resourceVersionId`) REFERENCES `resource_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
