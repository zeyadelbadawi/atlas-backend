/**
 * B0-SEC-13 — `privacy-requests`: a person asks for their data to be
 * deleted or exported, and follows their own requests.
 *
 * No `:userId` anywhere: the subject is always the account proved by the
 * access token. Reachable from an academy session as well as a management
 * session, because a learner has no other way to ask.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { CredentialCheckRateLimitGuard } from '../../identity/guards/credential-check-rate-limit.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AccountDeletionChallengeContract } from '../../identity/services/account-deletion-challenge.service';
import { FilePrivacyRequestDto } from '../dto/file-privacy-request.dto';
import type { MyPrivacyRequestResponse } from '../dto/privacy-request.contract';
import { PrivacyRequestsService } from '../services/privacy-requests.service';
import type { PrivacyExportBundle } from '../services/privacy-export.assembler';

@Controller('privacy-requests')
@UseGuards(JwtAuthGuard)
export class PrivacyRequestsController {
  constructor(private readonly privacyRequestsService: PrivacyRequestsService) {}

  /** Step one: a code is emailed to the account's verified address. Nothing is filed. */
  @Post('code')
  @UseGuards(CredentialCheckRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  requestCode(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<AccountDeletionChallengeContract> {
    return this.privacyRequestsService.requestCode(auth);
  }

  /** Step two: the code files the request (or returns the open one of that type). */
  @Post()
  @UseGuards(CredentialCheckRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  file(
    @CurrentAuthContext() auth: AuthContext,
    @Body() dto: FilePrivacyRequestDto,
  ): Promise<MyPrivacyRequestResponse> {
    return this.privacyRequestsService.file(auth, dto);
  }

  @Get('mine')
  listMine(@CurrentAuthContext() auth: AuthContext): Promise<MyPrivacyRequestResponse[]> {
    return this.privacyRequestsService.listMine(auth.userId);
  }

  /** The caller's data, while their fulfilled export's window is open. */
  @Get('mine/:id/export')
  @Header('Cache-Control', 'no-store')
  downloadExport(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PrivacyExportBundle> {
    return this.privacyRequestsService.downloadExport(auth.userId, id);
  }
}
