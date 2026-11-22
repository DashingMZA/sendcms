-- CreateTable
CREATE TABLE "UserAiSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "billingMode" "AiBillingMode" NOT NULL DEFAULT 'PLATFORM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAiSettings_userId_key" ON "UserAiSettings"("userId");

-- CreateIndex
CREATE INDEX "UserAiSettings_userId_idx" ON "UserAiSettings"("userId");

-- AddForeignKey
ALTER TABLE "UserAiSettings" ADD CONSTRAINT "UserAiSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
