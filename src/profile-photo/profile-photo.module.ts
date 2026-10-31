/**
 * ProfilePhotoModule — the account's own profile photo (mobile). A leaf
 * module: nothing imports it. `AuditLogWriterService` comes from its
 * `@Global()` module; `MediaModule` provides the public media bucket.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MediaModule } from '../media/media.module';
import { UserAvatarController } from './user-avatar.controller';
import { UserAvatarService } from './user-avatar.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule, MediaModule],
  controllers: [UserAvatarController],
  providers: [UserAvatarService],
})
export class ProfilePhotoModule {}
