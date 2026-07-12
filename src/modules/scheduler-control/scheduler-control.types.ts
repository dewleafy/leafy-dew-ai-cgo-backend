export type SchedulerJobRow = {
  id: string;
  seller_id: string;
  job_key: string;
  job_name: string;
  job_type: string;
  enabled: boolean;
  schedule_hint: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SchedulerJobRunRow = {
  id: string;
  seller_id: string;
  job_key: string;
  run_status: string;
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string | null;
};

export type SafeSchedulerJob = {
  id: string;
  sellerId: string;
  jobKey: string;
  jobName: string;
  jobType: string;
  enabled: boolean;
  scheduleHint: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SafeSchedulerJobRun = {
  id: string;
  sellerId: string;
  jobKey: string;
  runStatus: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string | null;
};
