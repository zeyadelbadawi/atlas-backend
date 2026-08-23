/** The narrow surface any future real transactional-email integration (Phase P17) implements. P1 only needs `sendPasswordResetEmail`. */
export interface EmailProvider {
  sendPasswordResetEmail(to: string, rawToken: string): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
