-- Additive rollout: deploy schema, configure the private bucket, then deploy readers/writers.
-- Legacy bodies remain intact until the separately invoked, verified migration clears them.
ALTER TABLE "ow_projects_file"
    ADD COLUMN "storage_provider" VARCHAR(16),
    ADD COLUMN "storage_bucket" VARCHAR(255),
    ADD COLUMN "storage_key" TEXT,
    ADD COLUMN "content_size" BIGINT,
    ADD COLUMN "content_sha256" VARCHAR(64),
    ADD COLUMN "content_type" VARCHAR(255),
    ADD COLUMN "search_preview" TEXT,
    ADD COLUMN "search_vector" tsvector;

ALTER TABLE "ow_projects_file" ADD CONSTRAINT "ow_projects_file_storage_pointer_check"
    CHECK ("storage_provider" IS NULL OR (
        "storage_provider" = 's3' AND "storage_bucket" IS NOT NULL AND "storage_bucket" <> ''
        AND "storage_key" IS NOT NULL AND "storage_key" <> ''
        AND "content_size" IS NOT NULL AND "content_size" >= 0
        AND "content_sha256" IS NOT NULL AND "content_sha256" ~ '^[a-f0-9]{64}$'
    ));

CREATE INDEX "idx_ow_projects_file_search_vector"
    ON "ow_projects_file" USING GIN ("search_vector");
