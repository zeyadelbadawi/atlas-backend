import { IsIn, IsNotEmpty } from 'class-validator';

/** `finish` = "Finish" (all required steps done); `defer` = "Finish for now". */
export class CompleteOnboardingDto {
  @IsNotEmpty()
  @IsIn(['finish', 'defer'])
  readonly mode!: 'finish' | 'defer';
}
