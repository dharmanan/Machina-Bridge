import korayLogo from '../assets/koray-footer-logo.svg'

export default function DesignedByFooter() {
  return (
    <a
      href="https://koraycifci.com"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-3 rounded-2xl px-3 py-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
      aria-label="Designed by Koray Cifci"
    >
      <span className="text-xs font-medium uppercase tracking-[0.18em]">Designed by</span>
      <img src={korayLogo} alt="Koray Cifci" className="h-14 w-auto object-contain" />
    </a>
  )
}
