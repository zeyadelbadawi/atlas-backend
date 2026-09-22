/**
 * P64 Phase 3 (AD-11) — completion surfaces.
 *
 *   GET  /learning/courses/:courseId/completion          learner completion screen
 *   GET  /academies/:id/courses/:courseId/completion-rule staff view of the rule
 *   PUT  /academies/:id/courses/:courseId/completion-rule owner / manager update
 *
 * The learner route is authenticated only at the route (authorization is
 * the active enrollment inside the service); the staff routes carry the
 * same three guards every academy management controller does.
 */
import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { CourseCompletionService } from '../services/course-completion.service';
import { UpdateCompletionRuleDto } from '../dto/completion-rule.dto';
import type {
  CourseCompletionResponse,
  CourseCompletionRuleResponse,
} from '../dto/completion.contract';

@Controller('learning')
@UseGuards(JwtAuthGuard)
export class LearnerCompletionController {
  constructor(private readonly completion: CourseCompletionService) {}

  @Get('courses/:courseId/completion')
  async getCompletion(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<CourseCompletionResponse> {
    return this.completion.learnerView(request.authContext!.userId, courseId);
  }
}

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class CourseCompletionRuleController {
  constructor(private readonly completion: CourseCompletionService) {}

  @Get(':id/courses/:courseId/completion-rule')
  async getRule(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<CourseCompletionRuleResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.completion.staffView(
      academyId,
      organizationId,
      request.authContext!.userId,
      courseId,
    );
  }

  @Put(':id/courses/:courseId/completion-rule')
  async updateRule(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: UpdateCompletionRuleDto,
  ): Promise<CourseCompletionRuleResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.completion.updateRule(
      academyId,
      organizationId,
      request.authContext!.userId,
      courseId,
      body,
    );
  }
}
