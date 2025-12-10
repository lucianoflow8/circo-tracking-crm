-- CreateTable
CREATE TABLE "PhoneProfile" (
    "phone" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
