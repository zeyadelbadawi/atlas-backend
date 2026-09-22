import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export class ListCertificatesQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsString()
  readonly courseId?: string;

  @IsOptional()
  @IsIn(['issued', 'revoked'])
  readonly status?: 'issued' | 'revoked';
}

export class RevokeCertificateDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  readonly reason!: string;
}

export class RegenerateCertificateDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reason?: string;
}

export class IssueCertificateDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reason?: string;

  /** Issue even when the completion rule is not met (owner/manager edge case, audited). */
  @IsOptional()
  readonly force?: boolean;
}

export class CertificateWordingDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  readonly body?: string;
}

/** P64 Phase 3 (D6) — the academy's identity on the platform-standard layout. */
export class UpdateCertificateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  readonly name?: string;

  @IsOptional()
  @ValidateIf((o) => o.logoUrl !== null)
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  @MaxLength(2000)
  readonly logoUrl?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.signatureUrl !== null)
  @IsUrl({ require_tld: false, protocols: ['https', 'http'] })
  @MaxLength(2000)
  readonly signatureUrl?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.signatoryName !== null)
  @IsString()
  @MaxLength(120)
  readonly signatoryName?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.signatoryTitle !== null)
  @IsString()
  @MaxLength(120)
  readonly signatoryTitle?: string | null;

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  readonly wording?: { en?: CertificateWordingDto; ar?: CertificateWordingDto };
}
