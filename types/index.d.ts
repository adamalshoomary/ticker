/** The update line above the prompt; null shows none. */
export type UpdateView =
  | { phase: 'offer'; current: string; latest: string }
  | { phase: 'updating'; latest: string }
  | { phase: 'done'; text: string; isWarning: boolean }
  | null

declare module 'claude-code' {
  interface PluginState {
    ticker: {
      update: UpdateView
    }
  }
}
