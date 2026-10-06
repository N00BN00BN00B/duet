import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SyncAction, SyncItem, SyncKind } from '@shared/types'
import { duet } from '@/lib/api'
import { formatBytes, projectName, timeAgo } from '@/lib/format'
import { toast, toastError, useApp } from '@/state/store'
import { planActions, type Strategy } from '@/lib/syncPlan'
import { ProviderLogo } from '../brand'
import { IconArrowLeft, IconArrowRight, IconCheck, IconRefresh, IconSync, Spinner } from '../icons'
import { Button, Chip, Dialog, EmptyState, IconButton, Segmented } from '../ui/primitives'
import { Card, Page, Section } from './Page'

const KIND_INFO: Record<SyncKind, { title: string; description: string }> = {
  instructions: { title: 'Instructions', description: 'CLAUDE.md for Claude, AGENTS.md for Codex — the rules both agents follow.' },
  skill: { title: 'Skills', description: 'Skill folders (SKILL.md) from ~/.claude/skills and ~/.codex/skills. Both agents use the same format.' },
  command: { title: 'Custom commands', description: 'Claude slash commands (~/.claude/commands) and Codex prompts (~/.codex/prompts).' },
  mcp: { title: 'MCP servers', description: 'User-level servers in ~/.claude.json and ~/.codex/config.toml.' }
}


function stateChip(item: SyncItem) {
  switch (item.state) {
    case 'same':
      return (
        <Chip tone="ok">
          <IconCheck size={10} /> In sync
        </Chip>
      )
    case 'claude-only':
      return (
        <Chip tone="neutral">
          <ProviderLogo provider="claude" size={10} /> Only in Claude
        </Chip>
      )
    case 'codex-only':
      return (
        <Chip tone="neutral">
          <ProviderLogo provider="codex" size={10} /> Only in Codex
        </Chip>
      )
    default:
      return <Chip tone="warn">Different{item.newer ? ` · ${item.newer === 'claude' ? 'Claude' : 'Codex'} newer` : ''}</Chip>
  }
}

export function SyncView() {
  const project = useApp((s) => (s.currentId ? s.threads[s.currentId]?.cwd : s.homeProject) ?? undefined)
  const [items, setItems] = useState<SyncItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [strategy, setStrategy] = useState<Strategy>('newest')
  const [confirm, setConfirm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await duet.sync.scan(project))
    } catch (e) {
      toastError(e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [project])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (actions: SyncAction[], label: string) => {
    if (!actions.length) return
    setBusy(label)
    try {
      const res = await duet.sync.apply(actions, project)
      if (res.errors.length) toast(`Synced ${res.applied}, ${res.errors.length} failed: ${res.errors[0]}`, 'error')
      else toast(`Synced ${res.applied} item${res.applied === 1 ? '' : 's'}`, 'success')
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }

  const grouped = useMemo(() => {
    const g: Record<SyncKind, SyncItem[]> = { instructions: [], skill: [], command: [], mcp: [] }
    for (const i of items ?? []) g[i.kind].push(i)
    return g
  }, [items])
  const plan = useMemo(() => planActions(items ?? [], strategy), [items, strategy])
  const outOfSync = (items ?? []).filter((i) => i.state !== 'same').length

  return (
    <Page
      title="Sync"
      testId="sync-view"
      subtitle="Keep Claude Code and Codex set up the same way. Duet compares instructions, skills, custom commands and MCP servers, and copies them across in whichever direction you choose. Anything it overwrites is saved first."
      actions={
        <>
          <IconButton label="Rescan" onClick={() => void load()}>
            {loading ? <Spinner size={14} /> : <IconRefresh size={15} />}
          </IconButton>
          <Button size="sm" variant="accent" icon={<IconSync size={13} />} disabled={!outOfSync || !!busy} onClick={() => setConfirm(true)} data-testid="sync-everything">
            Sync everything
          </Button>
        </>
      }
    >
      {items && (
        <div className="anim-fade mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface px-4 py-3">
          <div className="flex items-center gap-2 text-[13px]">
            <ProviderLogo provider="claude" size={15} />
            <IconSync size={14} className="text-fg-3" />
            <ProviderLogo provider="codex" size={15} />
          </div>
          <div className="text-[13px]">{outOfSync === 0 ? <span className="text-ok">Everything is in sync.</span> : <span>{outOfSync} item{outOfSync === 1 ? '' : 's'} differ between the two agents.</span>}</div>
          {project && <span className="ml-auto text-[12px] text-fg-3">Project: {projectName(project)}</span>}
        </div>
      )}
      {items === null ? (
        <div className="flex justify-center py-12 text-fg-3">
          <Spinner size={18} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<IconSync size={18} />} title="Nothing to sync yet">
          Once you have instructions, skills or MCP servers in either agent, they show up here.
        </EmptyState>
      ) : (
        (Object.keys(KIND_INFO) as SyncKind[]).map((kind) =>
          grouped[kind].length ? (
            <Section key={kind} title={KIND_INFO[kind].title} description={KIND_INFO[kind].description}>
              <Card>
                {grouped[kind].map((item) => (
                  <div key={item.key} className="group/s flex min-h-[46px] items-center gap-3 border-b border-line px-4 py-2 last:border-b-0" data-testid="sync-row">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{item.name}</div>
                      <div className="mt-0.5 flex gap-3 text-[11px] text-fg-3">
                        {item.claude && (
                          <span className="flex items-center gap-1">
                            <ProviderLogo provider="claude" size={9} />
                            {item.claude.size ? formatBytes(item.claude.size) : 'configured'}
                            {item.claude.mtime ? ` · ${timeAgo(item.claude.mtime)}` : ''}
                          </span>
                        )}
                        {item.codex && (
                          <span className="flex items-center gap-1">
                            <ProviderLogo provider="codex" size={9} />
                            {item.codex.size ? formatBytes(item.codex.size) : 'configured'}
                            {item.codex.mtime ? ` · ${timeAgo(item.codex.mtime)}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    {stateChip(item)}
                    <div className="flex w-[196px] justify-end gap-1">
                      {item.state !== 'same' && item.claude && (
                        <Button size="xs" variant="secondary" disabled={!!busy} onClick={() => void run([{ key: item.key, direction: 'to-codex' }], item.key)} icon={busy === item.key ? <Spinner size={11} /> : <ProviderLogo provider="claude" size={10} />}>
                          <IconArrowRight size={11} /> Codex
                        </Button>
                      )}
                      {item.state !== 'same' && item.codex && (
                        <Button size="xs" variant="secondary" disabled={!!busy} onClick={() => void run([{ key: item.key, direction: 'to-claude' }], item.key)} icon={<IconArrowLeft size={11} />}>
                          Claude <ProviderLogo provider="codex" size={10} />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            </Section>
          ) : null
        )
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Sync everything"
        description="Choose which side wins when both agents have a different version."
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              disabled={!plan.length}
              onClick={() => {
                setConfirm(false)
                void run(plan, 'all')
              }}
            >
              Sync {plan.length} item{plan.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 pb-1">
          <Segmented
            value={strategy}
            onChange={setStrategy}
            options={[
              { value: 'newest', label: 'Newest wins' },
              { value: 'to-codex', label: 'Claude → Codex' },
              { value: 'to-claude', label: 'Codex → Claude' }
            ]}
          />
          <p className="text-[12.5px] leading-relaxed text-fg-2">
            {strategy === 'newest'
              ? 'Items that exist on one side are copied to the other. When both differ, the most recently changed version is copied over the older one.'
              : strategy === 'to-codex'
                ? 'Codex is made to match Claude. Items that only exist in Codex are left alone.'
                : 'Claude is made to match Codex. Items that only exist in Claude are left alone.'}
          </p>
          <p className="text-[12px] text-fg-3">Overwritten files are copied to Duet’s data folder first, so nothing is lost.</p>
        </div>
      </Dialog>
    </Page>
  )
}
