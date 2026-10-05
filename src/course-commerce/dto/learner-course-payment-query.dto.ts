/** `GET course-payments` query — the learner's own payment history, optionally for one academy (the academy host the learner portal runs on). */
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export class LearnerCoursePaymentQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly academyId?: string;
}
