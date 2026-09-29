import { registerPlugin } from '@capacitor/core'

interface LqPrintPlugin {
  print(options: { jobName: string; landscape: boolean }): Promise<void>
}

const LqPrint = registerPlugin<LqPrintPlugin>('LqPrint')

export async function printAndroidPage(jobName: string, landscape: boolean): Promise<void> {
  await LqPrint.print({ jobName, landscape })
}
