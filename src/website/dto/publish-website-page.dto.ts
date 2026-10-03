import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Publishing one page (Task H).
 *
 * `expectedVersion` pins WHAT is published: the editor sends the version
 * it has just saved, and a colleague's later save makes the publish a 409
 * (`StaleResourceVersionException`, same payload as a stale save) instead
 * of putting content live that the publisher never saw. Optional, so
 * callers that predate it keep their behaviour (publish the current
 * version).
 */
export class PublishWebsitePageDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  readonly expectedVersion?: number;
}
