-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` ENUM('USER', 'SUPER_ADMIN') NOT NULL DEFAULT 'USER',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuthSession` (
    `id` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AuthSession_token_key`(`token`),
    INDEX `AuthSession_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `masterBpm` INTEGER NOT NULL DEFAULT 90,
    `masterKey` VARCHAR(191) NULL,
    `quantize` VARCHAR(191) NOT NULL DEFAULT '1bar',
    `beatsPerBar` INTEGER NOT NULL DEFAULT 4,
    `genPrefs` JSON NULL,
    `gridPrefs` JSON NULL,
    `fx` JSON NULL,
    `loopSong` BOOLEAN NOT NULL DEFAULT false,
    `playMode` VARCHAR(191) NOT NULL DEFAULT 'live',
    `showAutomation` BOOLEAN NOT NULL DEFAULT true,
    `isExample` BOOLEAN NOT NULL DEFAULT false,
    `forkedFromExampleId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Project_userId_idx`(`userId`),
    INDEX `Project_isExample_idx`(`isExample`),
    UNIQUE INDEX `Project_userId_forkedFromExampleId_key`(`userId`, `forkedFromExampleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExampleDismissal` (
    `userId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ExampleDismissal_projectId_idx`(`projectId`),
    PRIMARY KEY (`userId`, `projectId`)
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
    `userId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `mode` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'suno',
    `prompt` TEXT NOT NULL,
    `bpm` INTEGER NOT NULL,
    `musicalKey` VARCHAR(191) NULL,
    `loop` BOOLEAN NOT NULL DEFAULT true,
    `instrumental` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `error` TEXT NULL,
    `sunoBatchId` VARCHAR(191) NULL,
    `sunoClipIds` JSON NULL,
    `trashed` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Gen_userId_idx`(`userId`),
    INDEX `Gen_projectId_idx`(`projectId`),
    INDEX `Gen_status_idx`(`status`),
    INDEX `Gen_trashed_idx`(`trashed`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Sound` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
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
    `parentSoundId` VARCHAR(191) NULL,
    `stemKind` VARCHAR(191) NULL,
    `stemStatus` VARCHAR(191) NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `tags` VARCHAR(191) NULL,
    `trashed` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Sound_userId_idx`(`userId`),
    INDEX `Sound_originProjectId_idx`(`originProjectId`),
    INDEX `Sound_trashed_idx`(`trashed`),
    INDEX `Sound_parentSoundId_idx`(`parentSoundId`),
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

-- CreateTable
CREATE TABLE `StudioSession` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `index` INTEGER NOT NULL,
    `repeats` INTEGER NOT NULL DEFAULT 1,
    `color` VARCHAR(191) NULL,
    `xyAuto` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `StudioSession_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StudioInstrument` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `slot` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `color` VARCHAR(191) NULL,
    `icon` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `gainDb` DOUBLE NOT NULL DEFAULT 0,
    `pan` DOUBLE NOT NULL DEFAULT 0,
    `eqLowDb` DOUBLE NOT NULL DEFAULT 0,
    `eqMidDb` DOUBLE NOT NULL DEFAULT 0,
    `eqHighDb` DOUBLE NOT NULL DEFAULT 0,
    `collageBars` INTEGER NULL,
    `stepsPerBar` INTEGER NULL,
    `loopStartStep` INTEGER NULL DEFAULT 0,
    `bakedAssetId` VARCHAR(191) NULL,
    `sends` JSON NULL,
    `extra` JSON NULL,

    INDEX `StudioInstrument_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Clip` (
    `id` VARCHAR(191) NOT NULL,
    `instrumentId` VARCHAR(191) NOT NULL,
    `soundId` VARCHAR(191) NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `startSample` INTEGER NOT NULL,
    `endSample` INTEGER NOT NULL,
    `bars` DOUBLE NOT NULL,
    `timeMul` DOUBLE NULL,
    `semitones` DOUBLE NOT NULL DEFAULT 0,
    `fadeOutBars` DOUBLE NULL,
    `fadeSilenceBars` DOUBLE NULL,
    `gainDb` DOUBLE NOT NULL DEFAULT 0,
    `pan` DOUBLE NOT NULL DEFAULT 0,
    `eqLowDb` DOUBLE NOT NULL DEFAULT 0,
    `eqMidDb` DOUBLE NOT NULL DEFAULT 0,
    `eqHighDb` DOUBLE NOT NULL DEFAULT 0,
    `startStep` INTEGER NULL,
    `orderIndex` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Clip_instrumentId_idx`(`instrumentId`),
    INDEX `Clip_soundId_idx`(`soundId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AuthSession` ADD CONSTRAINT `AuthSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExampleDismissal` ADD CONSTRAINT `ExampleDismissal_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Gen` ADD CONSTRAINT `Gen_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Gen` ADD CONSTRAINT `Gen_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_originProjectId_fkey` FOREIGN KEY (`originProjectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_genId_fkey` FOREIGN KEY (`genId`) REFERENCES `Gen`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Sound` ADD CONSTRAINT `Sound_parentSoundId_fkey` FOREIGN KEY (`parentSoundId`) REFERENCES `Sound`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE `StudioSession` ADD CONSTRAINT `StudioSession_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudioInstrument` ADD CONSTRAINT `StudioInstrument_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `StudioSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Clip` ADD CONSTRAINT `Clip_instrumentId_fkey` FOREIGN KEY (`instrumentId`) REFERENCES `StudioInstrument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Clip` ADD CONSTRAINT `Clip_soundId_fkey` FOREIGN KEY (`soundId`) REFERENCES `Sound`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Clip` ADD CONSTRAINT `Clip_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

