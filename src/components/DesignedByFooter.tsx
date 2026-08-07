export default function DesignedByFooter() {
  return (
    <a
      href="https://koraycifci.com"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Designed by Koray Cifci"
      className="inline-flex items-center gap-2 text-slate-500 transition-colors hover:text-slate-900 focus:outline-none"
    >
      <span className="text-xs font-medium uppercase tracking-[0.18em]">
        Designed by
      </span>

      <img
        src="/koray-logo.png"
        alt="Koray Cifci"
        className="h-14 w-14 -my-4 object-contain"
      />
    </a>
  )
}
