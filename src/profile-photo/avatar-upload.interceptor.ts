/**
 * The multipart upload for `POST /users/me/avatar`: memory storage, one
 * file field named `file`, at most 5 MB, no other fields. Runs after the
 * JWT guard, so an anonymous caller never gets a body parsed. Multer's own
 * English refusals become the API's message keys.
 */
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { catchError, type Observable, throwError } from 'rxjs';
import { AVATAR_ERRORS, AVATAR_MAX_BYTES } from './user-avatar.service';

export const AvatarFileInterceptor = FileInterceptor('file', {
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 },
});

function hasMessageKey(error: HttpException): boolean {
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'messageKey' in body;
}

@Injectable()
export class AvatarUploadErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException && !hasMessageKey(error)) {
          if (error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) {
            return throwError(
              () => new PayloadTooLargeException({ messageKey: AVATAR_ERRORS.tooLarge }),
            );
          }
          if (error.getStatus() === HttpStatus.BAD_REQUEST) {
            return throwError(
              () => new BadRequestException({ messageKey: AVATAR_ERRORS.invalid }),
            );
          }
        }
        return throwError(() => error);
      }),
    );
  }
}
