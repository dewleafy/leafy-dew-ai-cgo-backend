export type QaSmokeCheckStatus = "PASS" | "WARN" | "FAIL";

export type QaSmokeCheck = {
  key: string;
  name: string;
  status: QaSmokeCheckStatus;
  critical: boolean;
  message: string;
  durationMs: number;
};

export type QaSmokeRunRow = {
  id: string;
  seller_id: string;
  run_status: string;
  started_at: string;
  finished_at: string | null;
  total_checks: number;
  pass_count: number;
  warn_count: number;
  fail_count: number;
  checks: QaSmokeCheck[] | null;
  blockers: unknown[] | null;
  warnings: unknown[] | null;
  created_at: string;
};

export type SafeQaSmokeRun = {
  id: string;
  sellerId: string;
  runStatus: string;
  startedAt: string;
  finishedAt: string | null;
  totalChecks: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  checks: QaSmokeCheck[];
  blockers: unknown[];
  warnings: unknown[];
  createdAt: string;
};
