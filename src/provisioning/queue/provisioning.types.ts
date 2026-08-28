/** Master plan §12/§21 Phase P14: "Provisioning orchestration | provisioning-worker." */
export const PROVISIONING_QUEUE = 'provisioning';

export const PROCESS_PROVISIONING_JOB = 'process-provisioning-request';

export interface ProcessProvisioningJobPayload {
  readonly provisioningRequestId: string;
  readonly organizationId: string;
}
