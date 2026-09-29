import { Share, type ShareOptions } from '@capacitor/share'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

export function isShareCanceledError(error: unknown): boolean {
  return /^share cancel(?:ed|led)$/i.test(errorMessage(error).trim())
}

export async function shareAndroidFile(options: ShareOptions): Promise<{ canceled: boolean }> {
  try {
    await Share.share(options)
    return { canceled: false }
  } catch (error) {
    if (isShareCanceledError(error)) return { canceled: true }
    throw error
  }
}
