-- Phase 2: at most one PLATFORM_OWNER. Backs the first-user promotion in
-- lib/auth.ts (single-statement conditional UPDATE) at the database level:
-- even two perfectly simultaneous first sign-ups can't both promote, the
-- second UPDATE hits this index. The promotion hook catches that error and
-- leaves the user PLATFORM_USER, so registration never fails because of it.
-- Hand-written (Prisma's schema can't express a partial index); safe on a
-- fresh database — sendcms was never deployed, so no rows exist yet.
-- CreateIndex
CREATE UNIQUE INDEX "User_single_platform_owner_idx" ON "User" ("platformRole") WHERE "platformRole" = 'PLATFORM_OWNER';
