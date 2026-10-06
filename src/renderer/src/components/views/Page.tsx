import type { ReactNode } from 'react'
import { useApp } from '@/state/store'
import { IconSidebar } from '../icons'
import { IconButton } from '../ui/primitives'

/** Shared chrome for the hub pages (History, MCP, Sync, Backups, Settings). */
export function Page({ title, subtitle, actions, children, testId }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid={testId}>
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-line pr-4" style={{ paddingLeft: sidebarOpen ? 20 : 84 }}>
        {!sidebarOpen && (
          <IconButton label="Show sidebar" shortcut="⌘B" onClick={() => useApp.setState({ sidebarOpen: true })}>
            <IconSidebar size={16} />
          </IconButton>
        )}
        <h1 className="text-[13.5px] font-medium">{title}</h1>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      <div className="scroll-y min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[880px] px-6 pb-16 pt-6">
          {subtitle && <p className="anim-fade mb-5 max-w-[640px] text-[13px] leading-relaxed text-fg-2">{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  )
}

export function Section({ title, description, children, actions }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="anim-rise mb-7">
      <div className="mb-2.5 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[13.5px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-2">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-line bg-surface ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-[48px] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 ${className}`}>{children}</div>
}
