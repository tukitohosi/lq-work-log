export interface SharedMonthlyRateRecord {
  workerId: string
  month: string
  dailyRateFen: number
}

export interface SharedDailyRateWorker {
  id: string
  defaultDailyRateFen: number
}

export interface SharedDailyRateData {
  monthlyRecords: readonly SharedMonthlyRateRecord[]
}

export interface SharedResolvedDailyRate {
  rateFen: number
  sourceMonth: string | null
}

export function resolveEffectiveDailyRate(
  data: SharedDailyRateData,
  worker: SharedDailyRateWorker,
  month: string,
  workerRecords?: readonly SharedMonthlyRateRecord[],
): SharedResolvedDailyRate
