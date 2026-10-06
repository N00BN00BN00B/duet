import type { DuetApi } from '../shared/api'

declare global {
  interface Window {
    duet: DuetApi
  }
}

export {}
