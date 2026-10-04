/** `PUT organizations/:id/provisioning-requests/:requestId/brand-logo` — attaches the setup form's logo, already uploaded to the new Academy's media library, by media-asset id only (never bytes, never a URL the caller made up). */
import { IsUUID } from 'class-validator';

export class AttachProvisioningLogoDto {
  @IsUUID()
  readonly mediaAssetId!: string;
}
