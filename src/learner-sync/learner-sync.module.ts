/**
 * Atlas mobile app — the learner's own notes and study days, synced with
 * the server. Leaf module (nothing imports it); the web does not call it.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { LearnerSyncController } from './learner-sync.controller';
import { LearnerNotesService } from './learner-notes.service';
import { StudyDaysService } from './study-days.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [LearnerSyncController],
  providers: [LearnerNotesService, StudyDaysService],
})
export class LearnerSyncModule {}
