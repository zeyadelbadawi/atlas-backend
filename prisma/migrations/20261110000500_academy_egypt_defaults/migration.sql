-- Egypt is the platform default market: new Academies start on Egyptian Pound
-- and Cairo time. Only the column defaults change; existing Academies keep
-- whatever currency/timezone they already have.
ALTER TABLE "academies" ALTER COLUMN "timezone" SET DEFAULT 'Africa/Cairo';
ALTER TABLE "academies" ALTER COLUMN "currency" SET DEFAULT 'EGP';
