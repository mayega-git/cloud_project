export type VersionState = 'OPEN' | 'CLOSING' | 'FROZEN';
export type ClosureState = 'WAITING' | 'DRAINING' | 'COPYING' | 'COMPLETED' | 'FAILED';
export type RestorationState = 'COPYING' | 'COMPLETED' | 'FAILED';
export type BranchAccess = 'READ' | 'WRITE';

export interface WriterAuthorization {
  userId: string;
  padId: string;
  admittedAt: Date;
  versionState: VersionState;
}

// The quota is intentionally unavailable until durable accounting exists.
export interface WriteCreditPolicy {
  authorize(userId: string, padId: string, operationId: string): Promise<'ALLOW' | 'DENY'>;
}
