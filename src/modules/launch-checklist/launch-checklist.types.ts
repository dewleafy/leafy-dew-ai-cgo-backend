export type LaunchChecklistItem = {
  key: string;
  label: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
  critical: boolean;
  metadata?: Record<string, unknown>;
};

export type LaunchChecklistSummary = {
  ok: boolean;
  sellerId: string;
  overallLaunchStatus: "NOT_READY" | "READY_FOR_SHADOW_LAUNCH" | "READY_FOR_LIMITED_LIVE_TEST";
  items: LaunchChecklistItem[];
  blockers: string[];
  warnings: string[];
  nextSteps: string[];
};
