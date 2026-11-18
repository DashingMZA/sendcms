-- DropForeignKey
ALTER TABLE "Site" DROP CONSTRAINT "Site_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "Page" DROP CONSTRAINT "Page_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_pageId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_parentId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_commenterId_fkey";

-- DropForeignKey
ALTER TABLE "CommentLike" DROP CONSTRAINT "CommentLike_commentId_fkey";

-- DropForeignKey
ALTER TABLE "ModerationLog" DROP CONSTRAINT "ModerationLog_commentId_fkey";

-- DropForeignKey
ALTER TABLE "BannedCommenter" DROP CONSTRAINT "BannedCommenter_siteId_fkey";

-- DropForeignKey
ALTER TABLE "BannedCommenter" DROP CONSTRAINT "BannedCommenter_commenterId_fkey";

-- DropForeignKey
ALTER TABLE "SiteMember" DROP CONSTRAINT "SiteMember_userId_fkey";

-- DropForeignKey
ALTER TABLE "SiteMember" DROP CONSTRAINT "SiteMember_siteId_fkey";

-- DropForeignKey
ALTER TABLE "SiteInvite" DROP CONSTRAINT "SiteInvite_siteId_fkey";

-- DropTable
DROP TABLE "Site";

-- DropTable
DROP TABLE "Page";

-- DropTable
DROP TABLE "Commenter";

-- DropTable
DROP TABLE "Comment";

-- DropTable
DROP TABLE "CommentLike";

-- DropTable
DROP TABLE "ModerationLog";

-- DropTable
DROP TABLE "BannedCommenter";

-- DropTable
DROP TABLE "SiteMember";

-- DropTable
DROP TABLE "SiteInvite";

-- DropEnum
DROP TYPE "CommentStatus";

-- DropEnum
DROP TYPE "SiteRole";

-- DropEnum
DROP TYPE "InviteStatus";

