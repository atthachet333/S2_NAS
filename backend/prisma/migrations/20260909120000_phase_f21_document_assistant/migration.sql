CREATE TABLE `assistant_threads` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `scope` ENUM('CURRENT_RESOURCE','SELECTED_RESOURCES','AUTHORIZED_LIBRARY') NOT NULL,
  `includeArchived` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), INDEX `assistant_threads_userId_updatedAt_idx` (`userId`,`updatedAt`),
  CONSTRAINT `assistant_threads_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `assistant_thread_resources` (
  `threadId` VARCHAR(191) NOT NULL, `resourceId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`threadId`,`resourceId`), INDEX `assistant_thread_resources_resourceId_idx` (`resourceId`),
  CONSTRAINT `assistant_thread_resources_threadId_fkey` FOREIGN KEY (`threadId`) REFERENCES `assistant_threads` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `assistant_thread_resources_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `assistant_messages` (
  `id` VARCHAR(191) NOT NULL, `threadId` VARCHAR(191) NOT NULL,
  `role` ENUM('USER','ASSISTANT') NOT NULL, `content` MEDIUMTEXT NOT NULL,
  `clientRequestId` VARCHAR(100) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE INDEX `assistant_messages_threadId_clientRequestId_key` (`threadId`,`clientRequestId`),
  INDEX `assistant_messages_threadId_createdAt_idx` (`threadId`,`createdAt`),
  CONSTRAINT `assistant_messages_threadId_fkey` FOREIGN KEY (`threadId`) REFERENCES `assistant_threads` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `assistant_citations` (
  `id` VARCHAR(191) NOT NULL, `messageId` VARCHAR(191) NOT NULL,
  `resourceId` VARCHAR(191) NOT NULL, `resourceVersionId` VARCHAR(191) NOT NULL,
  `evidenceId` VARCHAR(16) NOT NULL, `chunkIndex` INTEGER NULL,
  `startOffset` INTEGER NULL, `endOffset` INTEGER NULL,
  `textSource` ENUM('NATIVE_TEXT','OCR','HUMAN_CORRECTED') NOT NULL,
  `snippet` VARCHAR(500) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE INDEX `assistant_citations_messageId_evidenceId_key` (`messageId`,`evidenceId`),
  INDEX `assistant_citations_resourceId_resourceVersionId_idx` (`resourceId`,`resourceVersionId`),
  CONSTRAINT `assistant_citations_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `assistant_messages` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `assistant_citations_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `resources` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `assistant_citations_resourceVersionId_fkey` FOREIGN KEY (`resourceVersionId`) REFERENCES `resource_versions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
