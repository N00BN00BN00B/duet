import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ThreadMeta, TimelineItem } from '@shared/types'
import { buildBlocks, isSettledApproval, type Block } from '@/lib/timeline'
import { useApp } from '@/state/store'
import { IconArrowRight } from '../icons'
import { AgentHeader, ApprovalRecord, AssistantMessage, Notice, SwitchDivider, ThinkingIndicator, TurnFooter, UserMessage, WorkGroup } from './blocks'

export function Timeline({ meta, items }: { meta: ThreadMeta; items: TimelineItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const blocks = useMemo(() => buildBlocks(items), [items])
  const showDetails = useApp((s) => s.settings?.showTurnDetails ?? true)
  const running = meta.status === 'running' || meta.status === 'approval'
  const lastUserIndex = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return i
    return -1
  }, [items])
  const turnProvider = lastUserIndex >= 0 && items[lastUserIndex].kind === 'user' ? (items[lastUserIndex] as { provider: ProviderId }).provider : meta.provider
  // Approvals that went through aren't shown, so they don't count as what's on screen last.
  const tail = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (!isSettledApproval(items[i])) return items[i]
    return undefined
  }, [items])
  const showThinking = meta.status === 'running' && (!tail || tail.kind === 'user' || tail.kind === 'switch' || tail.kind === 'notice' || (tail.kind === 'assistant' && !tail.streaming) || tail.kind === 'approval')

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // Jump to the end when a different thread opens.
  useLayoutEffect(() => {
    stick.current = true
    setShowJump(false)
    scrollToBottom()
  }, [meta.id, scrollToBottom])

  // Follow new content while the user is at the bottom.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [scrollToBottom])

  const lastTop = useRef(0)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const movedUp = el.scrollTop < lastTop.current - 1
    lastTop.current = el.scrollTop
    // Only the reader scrolling up stops the follow; content that grows in the meantime (a
    // picture finishing loading) must not.
    if (distance < 80) stick.current = true
    else if (movedUp) stick.current = false
    setShowJump(distance > 400)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-y h-full" data-testid="timeline">
        <div ref={contentRef} className="mx-auto flex w-full max-w-[var(--chat-width,760px)] flex-col gap-3.5 px-6 pb-10 pt-6">
          {blocks.map((block) => (
            <div key={block.key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}>
              {renderBlock(block, running, showDetails)}
            </div>
          ))}
          {showThinking && <ThinkingIndicator provider={turnProvider} />}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => {
            stick.current = true
            scrollToBottom(true)
          }}
          className="press anim-rise absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[12px] text-fg-2 shadow-lg hover:text-fg"
        >
          <IconArrowRight size={12} className="rotate-90" /> Latest
        </button>
      )}
    </div>
  )
}

function renderBlock(block: Block, running: boolean, showDetails: boolean) {
  if (block.type === 'work') {
    return (
      <div>
        {block.showHeader && <AgentHeader provider={block.provider} />}
        <WorkGroup entries={block.entries} live={running && block.last} defaultOpen={running && block.last} />
      </div>
    )
  }
  const item = block.item
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />
    case 'assistant':
      return <AssistantMessage item={item} showHeader={!!block.showHeader} />
    case 'approval':
      return <ApprovalRecord item={item} />
    case 'switch':
      return <SwitchDivider item={item} />
    case 'notice':
      return <Notice item={item} />
    case 'turn':
      return showDetails ? <TurnFooter item={item} /> : null
    default:
      return null
  }
}
