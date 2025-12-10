/*
  Warnings:

  - A unique constraint covering the columns `[waMessageId]` on the table `Message` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Message" ADD COLUMN "status" TEXT;
ALTER TABLE "Message" ADD COLUMN "waMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_waMessageId_key" ON "Message"("waMessageId");

-- CreateIndex
CREATE INDEX "Message_waMessageId_idx" ON "Message"("waMessageId");
