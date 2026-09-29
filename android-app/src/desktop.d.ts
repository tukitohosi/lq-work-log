export {}

declare global {
  interface JigongbenDesktopSaveResult {
    canceled: boolean
    filePath?: string
  }

  interface JigongbenDesktopBridge {
    saveFile(options: {
      kind: 'json' | 'xlsx'
      filename: string
      data: string | Uint8Array
    }): Promise<JigongbenDesktopSaveResult>
    print(options?: { landscape?: boolean }): Promise<void>
    savePdf(options: { filename?: string; landscape?: boolean }): Promise<JigongbenDesktopSaveResult>
    setTheme(theme: 'light' | 'dark'): Promise<void>
    createWeeklyBackupIfDue(force?: boolean): Promise<{
      created: boolean
      reason?: 'disabled' | 'not-due'
      nextDueAt?: string
      createdAt?: string
      filename?: string
      revision?: number
    }>
    getWeeklyBackupStatus(): Promise<{
      lastFailureAt: string | null
      errorCode: string | null
    }>
    getApiSessionToken(): Promise<string>
    openWeeklyBackupFolder(): Promise<{ opened: true }>
    onCloseRequested(callback: (requestId: string) => void): () => void
    onCloseCancelled(callback: (requestId: string) => void): () => void
    completeClose(result: { requestId: string; ok: boolean; error?: string }): Promise<{
      accepted: boolean
      reason?: 'rejected' | 'expired' | 'unknown'
    }>
  }

  interface Window {
    jigongbenDesktop?: JigongbenDesktopBridge
  }
}
