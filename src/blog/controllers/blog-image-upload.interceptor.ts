/**
 * B3 — the multipart upload for `POST /platform-blog-images`.
 *
 * Multer runs as an INTERCEPTOR, so it only ever starts after the guards
 * (JWT, management surface, Platform Owner) have passed: an anonymous or
 * non-owner caller never gets a body parsed. Memory storage, one file
 * field named `file`, at most 5 MB (multer stops reading past the limit),
 * no other fields.
 *
 * Multer's own refusals are English strings; this maps them onto the
 * API's message keys so the dashboard can say what went wrong.
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
import { BLOG_IMAGE_ERRORS, BLOG_IMAGE_MAX_BYTES } from '../services/blog-images.service';

export const BlogImageFileInterceptor = FileInterceptor('file', {
  limits: { fileSize: BLOG_IMAGE_MAX_BYTES, files: 1, fields: 0, parts: 1 },
});

function hasMessageKey(error: HttpException): boolean {
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'messageKey' in body;
}

@Injectable()
export class BlogImageUploadErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException && !hasMessageKey(error)) {
          if (error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) {
            return throwError(
              () =>
                new PayloadTooLargeException({ messageKey: BLOG_IMAGE_ERRORS.tooLarge }),
            );
          }
          if (error.getStatus() === HttpStatus.BAD_REQUEST) {
            return throwError(
              () => new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid }),
            );
          }
        }
        return throwError(() => error);
      }),
    );
  }
}
