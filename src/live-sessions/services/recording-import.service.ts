/**
 * RecordingImportService — turns a finished Zoom recording into assets in
 * the academy's EXISTING media library.
 *
 * ONE RECORDING, MANY FILES, ONE QUOTA UNIT. Zoom routinely produces
 * several files for a single meeting (shared screen, active speaker,
 * audio-only, transcript). Each becomes its own `LiveSessionRecordingFile`
 * and its own `MediaAsset`, but they all hang off the single
 * `LiveSessionRecording` row whose `live_session_id` is UNIQUE — which is
 * why the allowance counts sessions rather than files.
 *
 * PER-FILE IDEMPOTENCY. `(recording_id, provider_file_id)` is UNIQUE, so a
 * redelivered `recording.completed` cannot import the same file twice —
 * and a partially-failed import can be retried and will only fetch what
 * is still missing, rather than duplicating what already succeeded.
 *
 * PARTIAL SUCCESS IS A REAL OUTCOME. A session can end with three of four
 * files imported because one download failed. That is recorded as
 * `failed` with the successful files intact, not silently reported as
 * complete — and a retry picks up only the missing one.
 *
 * NO PARALLEL STORAGE. Files go through `MediaService.importFromBuffer`,
 * the same path every other upload uses, so they land in R2 under the
 * academy's own prefix, count toward storage limits, and are served by
 * the existing media authorization rules. No R2 URL is ever exposed.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { MediaService } from '../../media/services/media.service';
import { ZoomOAuthService } from './zoom-oauth.service';
import { ZoomProvider } from '../providers/zoom.provider';

/**
 * A ceiling on a single downloaded file.
 *
 * A multi-hour cloud recording can be very large, and pulling it entirely
 * into memory is what would take the worker down. The real per-asset limit
 * is still `MediaService`'s own check; this is the earlier, cruder guard
 * that stops the fetch before the allocation.
 */
const MAX_RECORDING_FILE_BYTES = 2 * 1024 * 1024 * 1024;

@Injectable()
export class RecordingImportService {
  private readonly logger = new Logger(RecordingImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly mediaService: MediaService,
    private readonly zoomOAuthService: ZoomOAuthService,
    private readonly zoomProvider: ZoomProvider,
  ) {}

  async importForSession(args: {
    readonly liveSessionId: string;
    readonly academyId: string;
    readonly organizationId: string;
    readonly providerMeetingId: string;
  }): Promise<{ imported: number; failed: number }> {
    const { liveSessionId, academyId, organizationId, providerMeetingId } = args;

    const connection = await this.prisma.academyLiveProviderConnection.findUnique({
      where: { academyId },
    });
    if (!connection) {
      await this.markRecordingFailed(
        liveSessionId,
        organizationId,
        'provider_not_connected',
      );
      return { imported: 0, failed: 0 };
    }

    let accessToken: string;
    try {
      accessToken = await this.zoomOAuthService.getAccessTokenForAcademy(
        academyId,
        organizationId,
      );
    } catch {
      // The authorization is gone or needs renewing. Recorded as a
      // provider-agnostic reason and left retryable, exactly like a
      // transient fetch failure — the recording is not lost, it is
      // waiting for a reconnect.
      await this.markRecordingFailed(
        liveSessionId,
        organizationId,
        'provider_not_connected',
      );
      return { imported: 0, failed: 0 };
    }

    let files;
    try {
      files = await this.zoomProvider.fetchRecordingFiles(accessToken, providerMeetingId);
    } catch {
      // Provider-agnostic reason only. A transient Zoom failure leaves the
      // recording retryable rather than permanently broken.
      await this.markRecordingFailed(
        liveSessionId,
        organizationId,
        'provider_fetch_failed',
      );
      return { imported: 0, failed: 0 };
    }

    if (files.length === 0) {
      await this.markRecordingFailed(liveSessionId, organizationId, 'no_files_available');
      return { imported: 0, failed: 0 };
    }

    const recording = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.liveSessionRecording.findUnique({
          where: { liveSessionId },
          select: { id: true },
        }),
    );
    if (!recording) {
      // Quota is consumed before import is attempted, so a missing row
      // means the charge never happened and importing would bypass it.
      this.logger.error({ liveSessionId }, 'No recording row — refusing to import.');
      return { imported: 0, failed: 0 };
    }

    let imported = 0;
    let failed = 0;

    for (const file of files) {
      const already = await this.prisma.liveSessionRecordingFile.findUnique({
        where: {
          recordingId_providerFileId: {
            recordingId: recording.id,
            providerFileId: file.providerFileId,
          },
        },
        select: { id: true, mediaAssetId: true },
      });
      // Already fully imported — a redelivered event, or a retry after a
      // partial failure that got this far.
      if (already?.mediaAssetId) continue;

      try {
        if (!file.downloadUrl) throw new Error('no download url');
        if (file.sizeBytes && file.sizeBytes > MAX_RECORDING_FILE_BYTES) {
          throw new Error('file too large');
        }

        const buffer = await this.download(file.downloadUrl, accessToken);

        const asset = await this.mediaService.importFromBuffer(
          academyId,
          organizationId,
          {
            buffer,
            fileName: `live-session-${liveSessionId}-${file.providerFileId}`,
          },
        );

        await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
          tx.liveSessionRecordingFile.upsert({
            where: {
              recordingId_providerFileId: {
                recordingId: recording.id,
                providerFileId: file.providerFileId,
              },
            },
            create: {
              recordingId: recording.id,
              academyId,
              providerFileId: file.providerFileId,
              mediaAssetId: asset.id,
              fileType: file.fileType,
              sizeBytes: file.sizeBytes ? BigInt(file.sizeBytes) : null,
              importedAt: new Date(),
            },
            update: { mediaAssetId: asset.id, importedAt: new Date() },
          }),
        );
        imported += 1;
      } catch {
        // One bad file must not abandon the rest. Recorded and counted;
        // never logged with the download URL, which is a bearer credential.
        failed += 1;
        this.logger.warn(
          { liveSessionId, providerFileId: file.providerFileId },
          'Recording file import failed.',
        );
      }
    }

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.liveSessionRecording.update({
        where: { liveSessionId },
        data: {
          // `available` only when at least one file actually landed.
          // Partial success stays visible as `failed` so somebody can
          // retry rather than believing the recording is complete.
          status:
            imported > 0 && failed === 0
              ? 'available'
              : failed > 0
                ? 'failed'
                : 'processing',
          availableAt: imported > 0 ? new Date() : null,
          failureReason: failed > 0 ? 'partial_import_failure' : null,
        },
      }),
    );

    return { imported, failed };
  }

  /**
   * Fetches one recording file.
   *
   * Zoom's download URLs are bearer-authenticated with the SAME OAuth
   * access token, sent as a header rather than appended as a query
   * parameter, because query strings end up in proxy and access logs.
   *
   * It previously sent the academy's client SECRET here, which worked
   * only because S2S conflated the two; under OAuth the access token is
   * both correct and far less dangerous to hand to a download host.
   */
  private async download(url: string, token: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`download failed with status ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RECORDING_FILE_BYTES) {
      throw new Error('file too large');
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async markRecordingFailed(
    liveSessionId: string,
    organizationId: string,
    reason: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.liveSessionRecording.updateMany({
        where: { liveSessionId },
        // Quota is NOT released. The business event (a recording was
        // started at Atlas's request) genuinely happened; refunding it on
        // a download failure would let a retry loop mint free allowance.
        data: { status: 'failed', failureReason: reason },
      }),
    );
  }
}
