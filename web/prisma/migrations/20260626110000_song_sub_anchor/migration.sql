-- §37 Song 多轨 主/sub link:sub 锚定列 + 工程级命名 track 列表
ALTER TABLE `StudioSession`
  ADD COLUMN `songAnchorId` VARCHAR(191) NULL,
  ADD COLUMN `songOffsetBar` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `Project`
  ADD COLUMN `songLanes` JSON NULL;
