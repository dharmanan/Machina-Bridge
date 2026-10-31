import { useSyncExternalStore } from 'react'
import type { Wallet } from '@rainbow-me/rainbowkit'
import { createConnector, type CreateConnectorFn } from 'wagmi'

// RainbowKit starts the WalletConnect modal without awaiting it, so a failed start
// (provider init rejected or hanging, AppKit not loaded) leaves a button that does
// nothing. This wrapper only observes: it records failures for the wallet UI, never
// cancels, retries or changes a connection, and never touches requests or signatures.
const START_SLOW_MS = 15_000
type Stage = 'start' | 'connect'
type Code = 'WC_START_FAILED' | 'WC_START_SLOW' | 'WC_CONNECT_FAILED'
const TEXT: Record<Code, string> = {
  WC_START_FAILED: 'WalletConnect could not start in this browser, so no wallet list opened and nothing was connected. Reload the page and try again, or connect from a desktop browser.',
  WC_START_SLOW: 'WalletConnect has not started after 15 seconds, so no wallet list has opened and nothing is connected. It may still open; otherwise reload the page and try again, or connect from a desktop browser.',
  WC_CONNECT_FAILED: 'WalletConnect did not connect a wallet. Nothing was connected; try again or choose another option.',
}

// Each failure gets its own attempt number, so a repeated failure shows again after the
// previous one was dismissed.
type WalletConnectFailure = { message: string; attempt: number; code: Code }
let current: WalletConnectFailure | null = null, attempts = 0
const listeners = new Set<() => void>()
function publish(next: WalletConnectFailure | null) {
  if (!next && !current) return
  current = next
  listeners.forEach(listener => listener())
}
// Diagnostics are limited to our stage and code plus the error's class name (e.g. TypeError).
// Error messages are never shown: they can carry relay URLs with auth tokens or project IDs.
function fail(stage: Stage, code: Code, error?: unknown) {
  const kind = error instanceof Error && /^[A-Za-z]{1,40}Error$/.test(error.name) ? ` · ${error.name}` : ''
  publish({ message: `${TEXT[code]} (stage: ${stage} · code: ${code}${kind})`, attempt: ++attempts, code })
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useWalletConnectError() {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

// Closing the WalletConnect modal or rejecting in the wallet is the user's choice, not an error.
const userClosed = (error: unknown) => error instanceof Error && (error.name === 'UserRejectedRequestError' || /user rejected|connection request reset/i.test(error.message))

// One pending start check for the page: a new attempt or the user closing the modal clears it.
let slowTimer: ReturnType<typeof setTimeout> | undefined
function clearSlowCheck() { clearTimeout(slowTimer); slowTimer = undefined }
// Another wallet started connecting, or a wallet connected: a pending WalletConnect notice no longer applies.
export function clearWalletConnectCheck() { clearSlowCheck(); publish(null) }

export function withWalletConnectStatus(wallet: Wallet): Wallet {
  return {
    ...wallet,
    createConnector: details => {
      const create = wallet.createConnector(details)
      return createConnector(config => {
        const inner = create(config)
        type Connector = ReturnType<CreateConnectorFn>
        // RainbowKit reads getChainId() before connect(); both wait for the provider, so both watch its start.
        // A slow start only shows a notice: the same provider promise is still awaited, so a late start connects normally.
        async function watchStart(connector: Connector) {
          clearSlowCheck(); publish(null)
          slowTimer = setTimeout(() => fail('start', 'WC_START_SLOW'), START_SLOW_MS)
          try {
            await connector.getProvider()
          } catch (error) {
            fail('start', 'WC_START_FAILED', error)
            throw error
          } finally {
            clearSlowCheck()
          }
          if (current?.code === 'WC_START_SLOW') publish(null)
        }
        return {
          ...inner,
          async getChainId() {
            await watchStart(this)
            return inner.getChainId.call(this)
          },
          async connect(params) {
            await watchStart(this)
            try {
              return await inner.connect.call(this, params)
            } catch (error) {
              clearSlowCheck()
              if (userClosed(error)) publish(null)
              else fail('connect', 'WC_CONNECT_FAILED', error)
              throw error
            }
          },
        } as Connector
      })
    },
  }
}
