import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/** The relative path prefix `toMediaAssetUrl` emits for an uploaded public asset. */
const UPLOADED_MEDIA_PREFIX = '/api/v1/public/media/';

/**
 * A certificate's logo/signature is EITHER an external image URL an author
 * pasted, OR — far more commonly — an image they uploaded, whose reference is
 * the app-relative public-media path `toMediaAssetUrl` returns
 * (`/api/v1/public/media/...`). The certificate branding save used a bare
 * `@IsUrl`, which rejected that relative reference as "not a valid URL" — the
 * exact P4 Issue 7 failure, since the media library only ever hands back that
 * relative form. This accepts both without weakening `@IsUrl` anywhere else;
 * the renderer resolves the relative form to an absolute URL before fetching.
 */
function IsUploadedMediaOrUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isUploadedMediaOrUrl',
      target: object.constructor,
      propertyName,
      options: { message: 'validation:invalidUrl', ...options },
      validator: {
        validate(value: unknown): boolean {
          if (value === null || value === undefined) return true;
          if (typeof value !== 'string') return false;
          if (value.startsWith(UPLOADED_MEDIA_PREFIX)) return true;
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
          } catch {
            return false;
          }
        },
      },
    });
  };
}

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
  @IsUploadedMediaOrUrl()
  @MaxLength(2000)
  readonly logoUrl?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.signatureUrl !== null)
  @IsUploadedMediaOrUrl()
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

  // Constrained palette (4 roles). Format is checked here; cross-field
  // readability/contrast is enforced in the service (assertReadablePalette),
  // where all four values are known together.
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'errors.certificate.invalidColor' })
  readonly primaryColor?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'errors.certificate.invalidColor' })
  readonly accentColor?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'errors.certificate.invalidColor' })
  readonly textColor?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'errors.certificate.invalidColor' })
  readonly backgroundColor?: string;
}
