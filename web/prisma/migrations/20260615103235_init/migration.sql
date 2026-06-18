-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `masterBpm` INTEGER NOT NULL DEFAULT 90,
    `quantize` VARCHAR(191) NOT NULL DEFAULT '1bar',
    `beatsPerBar` INTEGER NOT NULL DEFAULT 4,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Asset` (
    `id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `contentType` VARCHAR(191) NOT NULL DEFAULT 'audio/mpeg',
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `sha256` VARCHAR(191) NULL,
    `sourceUrl` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Asset_sha256_key`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Gen` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `mode` VARCHAR(191) NOT NULL,
    `prompt` TEXT NOT NULL,
    `bpm` INTEGER NOT NULL,
    `musicalKey` VARCHAR(191) NULL,
    `loop` BOOLEAN NOT NULL DEFAULT true,
    `instrumental` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `error` TEXT NULL,
    `sunoBatchId` VARCHAR(191) NULL,
    `sunoClipIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Gen_projectId_idx`(`projectId`),
    INDEX `Gen_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Sound` (
    `id` VARCHAR(191) NOT NULL,
    `originProjectId` VARCHAR(191) NULL,
    `genId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `mode` VARCHAR(191) NOT NULL,
    `sourceBpm` DOUBLE NOT NULL,
    `musicalKey` VARCHAR(191) NULL,
    `durationSec` DOUBLE NOT NULL DEFAULT 0,
    `sampleRate` INTEGER NOT NULL DEFAULT 48000,
    `channels` INTEGER NOT NULL DEFAULT 2,
    `analysis` JSON NULL,
    `warp` JSON NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `tags` VARCHAR(191) NULL,
    `trashed` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Sound_originProjectId_idx`(`originProjectId`),
    INDEX `Sound_trashed_idx`(`trashed`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PadClip` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `bank` INTEGER NOT NULL,
    `padIndex` INTEGER NOT NULL,
    `sourceSoundId` VARCHAR(191) NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `warp` JSON NOT NULL,
    `label` VARCHAR(191) NULL,
    `gainDb` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PadClip_projectId_bank_padIndex_key`(`projectId`, `bank`, `padIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WarpRender` (
    `id` VARCHAR(191) NOT NULL,
    `signature` VARCHAR(191) NOT NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `bars` DOUBLE NOT NULL,
    `masterBpm` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WarpRender_signature_key`(`signature`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Gen` ADD CONSTRAINT `Gen_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_originProjectId_fkey` FOREIGN KEY (`originProjectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_genId_fkey` FOREIGN KEY (`genId`) REFERENCES `Gen`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PadClip` ADD CONSTRAINT `PadClip_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PadClip` ADD CONSTRAINT `PadClip_sourceSoundId_fkey` FOREIGN KEY (`sourceSoundId`) REFERENCES `Sound`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PadClip` ADD CONSTRAINT `PadClip_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WarpRender` ADD CONSTRAINT `WarpRender_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `Asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
