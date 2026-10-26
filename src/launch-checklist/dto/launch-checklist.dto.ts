/**
 * B3 — launch checklist request DTOs (class-validator).
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsHttpsOrSiteRelativeUrl } from '../../common/validation/safe-url.util';

export const CHECKLIST_SECTIONS = [
  'product',
  'content',
  'marketing',
  'communication',
  'operations',
] as const;
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

export const CHECKLIST_LIMITS = {
  title: { min: 1, max: 160 },
  description: { max: 1000 },
  notes: { max: 2000 },
  items: { max: 200 },
} as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class ChecklistItemFieldsDto {
  @IsOptional()
  @IsIn(CHECKLIST_SECTIONS)
  readonly section?: ChecklistSection;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(CHECKLIST_LIMITS.title.min)
  @MaxLength(CHECKLIST_LIMITS.title.max)
  readonly title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(CHECKLIST_LIMITS.description.max)
  readonly description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @IsHttpsOrSiteRelativeUrl()
  readonly linkUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(CHECKLIST_LIMITS.notes.max)
  readonly notes?: string;

  @IsOptional()
  @IsBoolean()
  readonly done?: boolean;
}

export class CreateChecklistItemDto extends ChecklistItemFieldsDto {
  @IsIn(CHECKLIST_SECTIONS)
  declare readonly section: ChecklistSection;

  @Transform(trim)
  @IsString()
  @MinLength(CHECKLIST_LIMITS.title.min)
  @MaxLength(CHECKLIST_LIMITS.title.max)
  declare readonly title: string;
}

export class UpdateChecklistItemDto extends ChecklistItemFieldsDto {
  /** Optimistic concurrency: the `version` the editor last read. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;
}

export class ReorderChecklistDto {
  /** Every item id, in the new order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CHECKLIST_LIMITS.items.max)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  readonly ids!: string[];
}
