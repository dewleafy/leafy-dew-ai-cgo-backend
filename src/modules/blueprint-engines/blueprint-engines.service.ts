import { supabase } from "../../db/supabase";

export type BlueprintEngineRow = {
  engine_no: number;
  engine_name: string;
  brain_group: string;
  mapped_template: string | null;
  build_status: string;
  status_note: string | null;
};

export async function getBlueprintCoverage() {
  const { data, error } = await supabase
    .from("blueprint_engines")
    .select("engine_no, engine_name, brain_group, mapped_template, build_status, status_note")
    .order("engine_no", { ascending: true })
    .limit(400);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as BlueprintEngineRow[];
  const byStatus: Record<string, number> = {};
  const byBrain: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    byStatus[r.build_status] = (byStatus[r.build_status] ?? 0) + 1;
    byBrain[r.brain_group] = byBrain[r.brain_group] ?? {};
    byBrain[r.brain_group][r.build_status] = (byBrain[r.brain_group][r.build_status] ?? 0) + 1;
  }
  return { total: rows.length, byStatus, byBrain, engines: rows };
}
