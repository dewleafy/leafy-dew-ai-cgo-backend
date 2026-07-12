export type LaunchGateCheckRow = {
  id: string;
  seller_id: string;
  check_key: string;
  check_name: string;
  status: string;
  severity: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  last_checked_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SafeLaunchGateCheck = {
  id: string;
  sellerId: string;
  checkKey: string;
  checkName: string;
  status: string;
  severity: string;
  message: string | null;
  metadata: Record<string, unknown>;
  lastCheckedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type LaunchGateSummary = {
  ok: boolean;
  sellerId: string;
  overallStatus: "PASS" | "WARN" | "FAIL";
  liveEligible: boolean;
  ppcLiveEligible: boolean;
  listingLiveEligible: boolean;
  blockers: string[];
  warnings: string[];
  nextSteps: string[];
  checks: SafeLaunchGateCheck[];
};
