/*
  Warnings:

  - A unique constraint covering the columns `[whatsappLineId,phone]` on the table `Contact` will be added. If there are existing duplicate values, this will fail.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WhatsappLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "sessionData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsappLine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_WhatsappLine" ("createdAt", "id", "name", "phoneNumber", "sessionData", "status", "userId") SELECT "createdAt", "id", "name", "phoneNumber", "sessionData", "status", "userId" FROM "WhatsappLine";
DROP TABLE "WhatsappLine";
ALTER TABLE "new_WhatsappLine" RENAME TO "WhatsappLine";
CREATE INDEX "WhatsappLine_userId_idx" ON "WhatsappLine"("userId");
CREATE INDEX "WhatsappLine_status_createdAt_idx" ON "WhatsappLine"("status", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Contact_whatsappLineId_idx" ON "Contact"("whatsappLineId");

-- CreateIndex
CREATE INDEX "Contact_lastMessageAt_idx" ON "Contact"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_whatsappLineId_phone_key" ON "Contact"("whatsappLineId", "phone");

-- CreateIndex
CREATE INDEX "Conversion_whatsappLineId_createdAt_idx" ON "Conversion"("whatsappLineId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversion_contactId_idx" ON "Conversion"("contactId");

-- CreateIndex
CREATE INDEX "Event_pageId_idx" ON "Event"("pageId");

-- CreateIndex
CREATE INDEX "Event_contactId_idx" ON "Event"("contactId");

-- CreateIndex
CREATE INDEX "Event_type_createdAt_idx" ON "Event"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Message_contactId_createdAt_idx" ON "Message"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_whatsappLineId_createdAt_idx" ON "Message"("whatsappLineId", "createdAt");

-- CreateIndex
CREATE INDEX "Page_userId_idx" ON "Page"("userId");

-- CreateIndex
CREATE INDEX "Page_whatsappLineId_idx" ON "Page"("whatsappLineId");
