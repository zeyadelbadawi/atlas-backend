-- P4 Issue G — constrained, customisable certificate palette (4 roles).
-- Additive only. Defaults reproduce the original Atlas design exactly, so
-- every existing template row and every already-issued certificate (which
-- renders from its immutable snapshot, not the template) is unchanged.
ALTER TABLE "certificate_templates"
  ADD COLUMN "primary_color"    TEXT NOT NULL DEFAULT '#1F4E5F',
  ADD COLUMN "accent_color"     TEXT NOT NULL DEFAULT '#B08A3E',
  ADD COLUMN "text_color"       TEXT NOT NULL DEFAULT '#14303A',
  ADD COLUMN "background_color" TEXT NOT NULL DEFAULT '#FCFBF7';
