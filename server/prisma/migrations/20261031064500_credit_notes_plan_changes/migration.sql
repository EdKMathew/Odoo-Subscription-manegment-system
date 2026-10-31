-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('OPEN', 'APPLIED', 'VOID');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "pendingPlanId" INTEGER,
ADD COLUMN     "renewalOfId" INTEGER,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubscriptionEvent" ADD COLUMN     "mrrDelta" INTEGER,
ADD COLUMN     "mrrKind" TEXT;

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "subscriptionId" INTEGER,
    "invoiceId" INTEGER,
    "reason" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "taxAmount" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER NOT NULL,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CreditApplied" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_CreditApplied_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote"("number");

-- CreateIndex
CREATE INDEX "CreditNote_customerId_status_idx" ON "CreditNote"("customerId", "status");

-- CreateIndex
CREATE INDEX "_CreditApplied_B_index" ON "_CreditApplied"("B");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_renewalOfId_key" ON "Subscription"("renewalOfId");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_mrrKind_createdAt_idx" ON "SubscriptionEvent"("mrrKind", "createdAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_renewalOfId_fkey" FOREIGN KEY ("renewalOfId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CreditApplied" ADD CONSTRAINT "_CreditApplied_A_fkey" FOREIGN KEY ("A") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CreditApplied" ADD CONSTRAINT "_CreditApplied_B_fkey" FOREIGN KEY ("B") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

