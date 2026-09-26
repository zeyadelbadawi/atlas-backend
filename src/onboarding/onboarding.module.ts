/**
 * OnboardingModule — New Customer Onboarding (docs/NEW_CUSTOMER_ONBOARDING.md).
 *
 * `@Global()` for ONE reason: to make `SIGNUP_ORGANIZATION_PORT` injectable
 * into `AuthService` without `IdentityModule` importing this module —
 * `PlansModule` already imports `IdentityModule`, so the reverse import would
 * be a cycle. Nothing else here is meant to be consumed elsewhere.
 */
import { Global, Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlansModule } from '../plans/plans.module';
import { SIGNUP_ORGANIZATION_PORT } from '../identity/services/signup-organization.port';
import { SignupOrganizationService } from './services/signup-organization.service';
import { OnboardingStatusService } from './services/onboarding-status.service';
import { OnboardingController } from './controllers/onboarding.controller';
import { PublicSignupOptionsController } from './controllers/public-signup-options.controller';

@Global()
@Module({
  imports: [AuthCoreModule, TenancyModule, PlansModule],
  controllers: [OnboardingController, PublicSignupOptionsController],
  providers: [
    SignupOrganizationService,
    { provide: SIGNUP_ORGANIZATION_PORT, useExisting: SignupOrganizationService },
    OnboardingStatusService,
  ],
  exports: [SIGNUP_ORGANIZATION_PORT],
})
export class OnboardingModule {}
