import { plainMessage } from '../lib/swap/userMessages'

// A message about a swap that has not started, in plain words. When the controller's original wording is more technical it stays available
// in a closed "Technical details" disclosure, so nothing the checks found is lost and nothing technical fills the screen.
export function PlainMessage({ raw, className = 'text-amber-800' }: { raw: string; className?: string }) {
  const plain = plainMessage(raw) ?? raw
  return <div role="alert" className={`break-words text-sm ${className}`}>
    <p>{plain}</p>
    {plain !== raw && <details className="mt-1 text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary><p className="mt-1">{raw}</p></details>}
  </div>
}
