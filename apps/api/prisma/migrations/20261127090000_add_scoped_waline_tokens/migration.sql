-- CreateTable
CREATE TABLE "ow_comment_tokens" (
    "id" SERIAL NOT NULL,
    "jti" VARCHAR(32) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "space_id" INTEGER NOT NULL,
    "parent_token_id" INTEGER NOT NULL,
    "scopes" JSONB NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ow_comment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ow_comment_tokens_jti_key" ON "ow_comment_tokens"("jti");

-- CreateIndex
CREATE UNIQUE INDEX "ow_comment_tokens_token_hash_key" ON "ow_comment_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "ow_comment_tokens_user_id_idx" ON "ow_comment_tokens"("user_id");

-- CreateIndex
CREATE INDEX "ow_comment_tokens_space_id_idx" ON "ow_comment_tokens"("space_id");

-- CreateIndex
CREATE INDEX "ow_comment_tokens_parent_token_id_idx" ON "ow_comment_tokens"("parent_token_id");

-- CreateIndex
CREATE INDEX "ow_comment_tokens_expires_at_idx" ON "ow_comment_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "ow_comment_tokens" ADD CONSTRAINT "ow_comment_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "ow_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ow_comment_tokens" ADD CONSTRAINT "ow_comment_tokens_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "ow_comment_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ow_comment_tokens" ADD CONSTRAINT "ow_comment_tokens_parent_token_id_fkey" FOREIGN KEY ("parent_token_id") REFERENCES "ow_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
