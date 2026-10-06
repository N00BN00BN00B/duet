import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AccessMode, Attachment, FileSuggestion, ProviderId, SlashCommand, ThreadMeta } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { duet, errorMessage } from '@/lib/api'
import { tildify } from '@/lib/format'
import { clearQueued, createAndSend, queueMessage, saveSettings, sendMessage, setAccess, setDraft, clearDraft, stopThread, switchProvider, toastError, updateThread, useApp, type Draft } from '@/state/store'
import { IconArrowUp, IconFile, IconFolder, IconPaperclip, IconStop, IconX } from '../icons'
import { AccessMenu, ContextRing, EffortMenu, ModelMenu, ProviderSwitch } from './pickers'
import { ApprovalPanel } from './ApprovalPanel'
import { IconButton, Kbd } from '../ui/primitives'

const EMPTY: Draft = { text: '', attachments: [] }

interface ComposerProps {
  mode: 'thread' | 'home'
  meta?: ThreadMeta
  project?: string | null
  onPickProject?: () => Promise<string | null>
  autoFocusKey?: number
}

type Popup = { kind: 'slash'; query: string; start: number } | { kind: 'mention'; query: string; start: number } | null

function detectPopup(text: string, caret: number): Popup {
  const before = text.slice(0, caret)
  const slash = before.match(/^\/([\w:.-]*)$/)
  if (slash) return { kind: 'slash', query: slash[1], start: 0 }
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (mention) return { kind: 'mention', query: mention[1], start: caret - mention[1].length - 1 }
  return null
}

export function Composer({ mode, meta, project, onPickProject, autoFocusKey }: ComposerProps) {
  const settings = useApp((s) => s.settings)
  const providers = useApp((s) => s.providers)
  const homeProvider = useApp((s) => s.homeProvider)
  const home = useApp((s) => s.info.home)
  const key = mode === 'thread' && meta ? meta.id : 'home'
  const draft = useApp((s) => s.drafts[key]) ?? EMPTY
  const items = useApp((s) => (meta ? s.items[meta.id] : undefined))
  const queued = useApp((s) => (meta ? s.queued[meta.id] : undefined))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [popup, setPopup] = useState<Popup>(null)
  const [popupIndex, setPopupIndex] = useState(0)
  const [commands, setCommands] = useState<Partial<Record<ProviderId, SlashCommand[]>>>({})
  const [files, setFiles] = useState<FileSuggestion[]>([])

  const provider: ProviderId = mode === 'thread' && meta ? meta.provider : homeProvider
  const status = providers[provider]
  const models = status?.models ?? []
  const model = mode === 'thread' && meta ? meta.models[provider] : settings?.defaultModels[provider]
  const modelInfo = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0]
  const effort = mode === 'thread' && meta ? meta.efforts[provider] : settings?.defaultEfforts[provider]
  const access: AccessMode = mode === 'thread' && meta ? meta.access : (settings?.defaultAccess ?? 'ask')
  const running = !!meta && (meta.status === 'running' || meta.status === 'approval')
  const cwd = mode === 'thread' && meta ? meta.cwd : (project ?? '')
  const approvals = useMemo(() => (items ?? []).filter((i) => i.kind === 'approval' && i.status === 'pending') as Extract<NonNullable<typeof items>[number], { kind: 'approval' }>[], [items])

  const update = useCallback((next: Partial<Draft>) => setDraft(key, { ...(useApp.getState().drafts[key] ?? EMPTY), ...next }), [key])

  // Auto-size the textarea.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [draft.text])

  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true })
  }, [autoFocusKey, key])

  // Slash commands per provider (cached).
  useEffect(() => {
    if (popup?.kind !== 'slash' || commands[provider]) return
    let cancelled = false
    duet.providers
      .commands(provider, cwd)
      .then((list) => !cancelled && setCommands((c) => ({ ...c, [provider]: list })))
      .catch(() => !cancelled && setCommands((c) => ({ ...c, [provider]: [] })))
    return () => {
      cancelled = true
    }
  }, [popup?.kind, provider, cwd, commands])

  // File mentions.
  useEffect(() => {
    if (popup?.kind !== 'mention' || !cwd) return
    let cancelled = false
    const t = setTimeout(() => {
      duet.files
        .suggest(cwd, popup.query)
        .then((list) => !cancelled && setFiles(list))
        .catch(() => !cancelled && setFiles([]))
    }, 70)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [popup, cwd])

  const popupItems = useMemo(() => {
    if (!popup) return []
    if (popup.kind === 'slash') {
      const q = popup.query.toLowerCase()
      return (commands[provider] ?? [])
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 40)
        .map((c) => ({ id: c.name, label: `/${c.name}`, detail: c.description, value: `/${c.name} ` }))
    }
    return files.map((f) => ({ id: f.path, label: f.path + (f.isDir ? '/' : ''), detail: '', value: `@${f.path}${f.isDir ? '/' : ''} ` }))
  }, [popup, commands, provider, files])

  useEffect(() => setPopupIndex(0), [popup?.kind, popup?.query])

  const applyPopup = (value: string) => {
    if (!popup) return
    const ta = textareaRef.current
    const caret = ta?.selectionStart ?? draft.text.length
    const text = draft.text.slice(0, popup.start) + value + draft.text.slice(caret)
    update({ text })
    setPopup(null)
    requestAnimationFrame(() => {
      const pos = popup.start + value.length
      ta?.setSelectionRange(pos, pos)
      ta?.focus()
    })
  }

  const addAttachments = async (list: FileList | File[]) => {
    const added: Attachment[] = []
    for (const file of Array.from(list)) {
      try {
        const path = duet.util.pathForFile(file)
        if (path) added.push(await duet.attachments.fromPath(path))
        else {
          const bytes = new Uint8Array(await file.arrayBuffer())
          added.push(await duet.attachments.fromBytes(file.name || 'pasted-image.png', file.type || 'application/octet-stream', bytes))
        }
      } catch (error) {
        toastError(error)
      }
    }
    if (added.length) update({ attachments: [...(useApp.getState().drafts[key]?.attachments ?? []), ...added] })
  }

  const pickFiles = async () => {
    const paths = await duet.app.pickFiles()
    const added: Attachment[] = []
    for (const p of paths) {
      try {
        added.push(await duet.attachments.fromPath(p))
      } catch (error) {
        toastError(error)
      }
    }
    if (added.length) update({ attachments: [...draft.attachments, ...added] })
  }

  const submit = async () => {
    if (busy) return
    const text = draft.text.trim()
    if (!text && draft.attachments.length === 0) return
    if (running && meta) {
      // The agent is busy: queue it and send automatically when the turn ends.
      queueMessage(meta.id, { text, attachments: draft.attachments })
      clearDraft(key)
      setPopup(null)
      return
    }
    if (status && !status.installed) {
      toastError(`${PROVIDER_LABEL[provider]} isn't installed. Switch agents or set it up in Settings.`)
      return
    }
    setBusy(true)
    const snapshot = draft
    clearDraft(key)
    setPopup(null)
    try {
      if (mode === 'home') {
        let dir = project ?? null
        if (!dir && onPickProject) dir = await onPickProject()
        if (!dir) {
          setDraft(key, snapshot)
          return
        }
        await createAndSend(dir, provider, { text, attachments: snapshot.attachments }, model)
      } else if (meta) {
        await sendMessage(meta.id, { text, attachments: snapshot.attachments })
      }
    } catch (error) {
      setDraft(key, snapshot)
      toastError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup && popupItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPopupIndex((i) => (i + 1) % popupItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPopupIndex((i) => (i - 1 + popupItems.length) % popupItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyPopup(popupItems[Math.min(popupIndex, popupItems.length - 1)].value)
        return
      }
    }
    if (e.key === 'Escape') {
      if (popup) {
        e.preventDefault()
        setPopup(null)
        return
      }
      if (running && meta) {
        e.preventDefault()
        void stopThread(meta.id)
        return
      }
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const sendWithEnter = settings?.sendWithEnter ?? true
      if ((sendWithEnter && !e.shiftKey && !e.altKey) || e.metaKey || e.ctrlKey) {
        e.preventDefault()
        void submit()
      }
    }
  }

  const onPickModel = (p: ProviderId, m: string) => {
    if (p !== provider) void switchProvider(p, m)
    else if (mode === 'thread' && meta) void updateThread(meta.id, { models: { [p]: m } })
    else if (settings) void saveSettings({ defaultModels: { ...settings.defaultModels, [p]: m } })
  }

  const onPickEffort = (value: string | undefined) => {
    if (mode === 'thread' && meta) void updateThread(meta.id, { efforts: { [provider]: value } })
    else if (settings) void saveSettings({ defaultEfforts: { ...settings.defaultEfforts, [provider]: value } })
  }

  const canSend = (draft.text.trim().length > 0 || draft.attachments.length > 0) && !busy
  const placeholder = running ? `${PROVIDER_LABEL[provider]} is working… type to queue a follow-up, Esc to stop` : mode === 'home' ? `Ask ${PROVIDER_LABEL[provider]} to build, fix or explain something` : `Message ${PROVIDER_LABEL[provider]}`

  return (
    <div className="relative">
      {meta && approvals.length > 0 && <ApprovalPanel threadId={meta.id} approvals={approvals} />}
      {popup && popupItems.length > 0 && (
        <div className="anim-pop absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[var(--pop-shadow)]" role="listbox">
          <div className="scroll-y max-h-64 p-1">
            {popupItems.map((it, i) => (
              <div
                key={it.id}
                role="option"
                aria-selected={i === popupIndex}
                onMouseEnter={() => setPopupIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyPopup(it.value)
                }}
                className={`flex items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] ${i === popupIndex ? 'bg-hover text-fg' : 'text-fg-2'}`}
              >
                <span className="shrink-0 font-mono text-[12px]">{it.label}</span>
                {it.detail && <span className="min-w-0 truncate text-[11.5px] text-fg-3">{it.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        className={`@container/composer relative z-[2] rounded-[22px] border bg-surface shadow-[var(--composer-shadow)] transition-[border-color,box-shadow] duration-300 ${dragging ? 'border-accent ring-accent' : 'border-line-strong focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--border-strong))]'}`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files.length) void addAttachments(e.dataTransfer.files)
        }}
        data-testid="composer"
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[22px] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] text-[13px] font-medium text-accent">
            Drop files to attach
          </div>
        )}
        {queued && meta && (
          <div className="anim-fade mx-3 mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px]" data-testid="queued-message">
            <span className="shrink-0 text-fg-3">Queued · sends when {PROVIDER_LABEL[provider]} finishes</span>
            <span className="min-w-0 flex-1 truncate text-fg-2">{queued.text || `${queued.attachments.length} attachment(s)`}</span>
            <button
              type="button"
              onClick={() => {
                clearQueued(meta.id)
                setDraft(key, { text: [queued.text, draft.text].filter(Boolean).join('\n\n'), attachments: [...queued.attachments, ...draft.attachments] })
              }}
              className="press shrink-0 rounded-md px-1.5 py-0.5 text-fg-3 hover:bg-hover hover:text-fg"
            >
              Edit
            </button>
            <button type="button" aria-label="Discard queued message" onClick={() => clearQueued(meta.id)} className="press shrink-0 rounded-md p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
              <IconX size={12} />
            </button>
          </div>
        )}
        {draft.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {draft.attachments.map((a) => (
              <div key={a.id} className="group/att relative">
                {a.mime.startsWith('image/') ? (
                  <button type="button" onClick={() => useApp.setState({ lightbox: a.path })} className="block overflow-hidden rounded-xl border border-line">
                    <img src={duet.util.fileUrl(a.path)} alt={a.name} className="h-16 w-16 object-cover" draggable={false} />
                  </button>
                ) : (
                  <div className="flex h-16 max-w-[180px] items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 text-[12px] text-fg-2">
                    <IconFile size={15} className="shrink-0" />
                    <span className="truncate">{a.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => update({ attachments: draft.attachments.filter((x) => x.id !== a.id) })}
                  className="press absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-surface text-fg-2 opacity-0 shadow transition-opacity group-hover/att:opacity-100 hover:text-fg focus:opacity-100"
                >
                  <IconX size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft.text}
          rows={1}
          spellCheck
          placeholder={placeholder}
          data-testid="composer-input"
          onChange={(e) => {
            update({ text: e.target.value })
            setPopup(detectPopup(e.target.value, e.target.selectionStart ?? e.target.value.length))
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => setPopup(detectPopup(e.currentTarget.value, e.currentTarget.selectionStart ?? 0))}
          onBlur={() => setTimeout(() => setPopup(null), 120)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length) {
              e.preventDefault()
              void addAttachments(files)
            }
          }}
          className="block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[0.97em] leading-relaxed text-fg outline-none placeholder:text-fg-3"
        />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <ProviderSwitch value={provider} statuses={providers} onChange={(p) => void switchProvider(p)} />
          <div className="ml-1 flex min-w-0 items-center gap-0.5">
            <ModelMenu provider={provider} model={model} statuses={providers} onPick={onPickModel} />
            <EffortMenu efforts={modelInfo?.efforts ?? []} value={effort} defaultEffort={modelInfo?.defaultEffort} onPick={onPickEffort} />
            <AccessMenu value={access} onPick={(a) => void setAccess(a)} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            {meta?.context && <ContextRing used={meta.context.usedTokens} total={meta.context.windowTokens} />}
            <IconButton label="Attach files or images" onClick={() => void pickFiles()}>
              <IconPaperclip size={16} />
            </IconButton>
            {running && meta && canSend && (
              <button
                type="button"
                aria-label="Queue message"
                title="Send when the agent finishes"
                onClick={() => void submit()}
                data-testid="queue-button"
                className="press flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-fg hover:bg-surface-3"
              >
                <IconArrowUp size={16} strokeWidth={2.2} />
              </button>
            )}
            {running && meta ? (
              <button
                type="button"
                aria-label="Stop"
                onClick={() => void stopThread(meta.id)}
                data-testid="stop-button"
                className="press flex h-8 w-8 items-center justify-center rounded-full bg-fg text-bg hover:opacity-90"
              >
                <IconStop size={15} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!canSend}
                onClick={() => void submit()}
                data-testid="send-button"
                className="press flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white shadow-[0_6px_16px_-6px_var(--accent)] transition-[background-color,opacity,box-shadow] duration-500 hover:brightness-110 disabled:bg-surface-3 disabled:text-fg-3 disabled:shadow-none"
              >
                <IconArrowUp size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
      {mode === 'home' && onPickProject && (
        <div className="mt-2 flex items-center justify-between px-2 text-[11.5px] text-fg-3">
          <button type="button" onClick={() => void onPickProject()} className="press flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg-2" data-testid="project-picker">
            <IconFolder size={13} />
            <span className="truncate" title={project ?? undefined}>{project ? tildify(project, home) : 'Choose a project folder'}</span>
          </button>
          <span className="hidden items-center gap-1 sm:flex">
            <Kbd>⌘1</Kbd> Claude <Kbd>⌘2</Kbd> Codex
          </span>
        </div>
      )}
    </div>
  )
}
