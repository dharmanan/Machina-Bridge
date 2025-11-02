/// <reference types="vite/client" />

declare module 'vite/client' {
  interface ImportMetaEnv {
    readonly VITE_CIRCLE_APP_ID: string
    readonly VITE_CIRCLE_API_KEY: string
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}
