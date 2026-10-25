ALTER TABLE business.closures ADD COLUMN IF NOT EXISTS retry_after timestamptz;
ALTER TABLE business.restorations ADD COLUMN IF NOT EXISTS retry_after timestamptz;
