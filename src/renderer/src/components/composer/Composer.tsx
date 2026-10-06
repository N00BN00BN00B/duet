import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AccessMode, Attachment, FileSuggestion, ProviderId, ReviewTarget, SlashCommand, ThreadMeta } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { duet, errorMessage } from '@/lib/api'
import { projectName, tildify } from '@/lib/format'
import { agentCommands, DUET_COMMANDS, parseCommand, rankCommands, reviewTarget, type CommandEntry } from '@/lib/commands'
import { useFitAbove } from '@/lib/fit'
import {
  addProject,
  clearDraft,
  clearQueued,
  compactThread,
  copyMarkdown,
  createAndSend,
  designTheme,
  forkThread,
  goHome,
  openBrowser,
  queueMessage,
  saveSettings,
  sendMessage,
  setAccess,
  setDraft,
  setView,
  stopThread,
  switchProvider,
  syncAllChats,
  toast,
  toastError,
  updateThread,
  useApp,
  type Draft
} from '@/state/store'
import { IconArrowUp, IconBolt, IconCheck, IconChevronDown, IconFile, IconFolder, IconPaperclip, IconPlus, IconSlash, IconSparkle, IconStop, IconX } from '../icons'
import { AccessMenu, ContextRing, EFFORT_LABEL, EffortMenu, ModelMenu, ProviderSwitch } from './pickers'
import { ApprovalPanel } from './ApprovalPanel'
import { CommandMenu } from './CommandMenu'
import { MenuItem, MenuLabel, MenuSeparator, Popover, useMenuKeys } from '../ui/Popover'
import { IconButton, Kbd, Tooltip } from '../ui/primitives'

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

const ACCESS_COMMAND: Record<string, AccessMode> = { plan: 'plan', ask: 'ask', auto: 'auto', 'full-access': 'full' }

/** Where a new chat goes: recent projects, a general chat, or another folder. */
function ProjectPicker({ project, onPick }: { project: string | null; onPick: (dir: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  const projects = useApp((s) => s.settings?.projects ?? [])
  const home = useApp((s) => s.info.home)
  const chatsDir = useApp((s) => s.info.chatsDir)
  const label = !project ? 'Choose where to work' : project === chatsDir ? 'General chat (no project)' : tildify(project, home)
  return (
    <div ref={anchor} className="min-w-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="press flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg-2" data-testid="project-picker" aria-expanded={open}>
        <IconFolder size={13} />
        <span className="truncate" title={project ?? undefined}>
          {label}
        </span>
        <IconChevronDown size={11} className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={300}>
        <div className="p-1.5" onKeyDown={keys}>
          {projects.length > 0 && <MenuLabel>Recent projects</MenuLabel>}
          <div className="scroll-y max-h-[260px]">
            {projects.slice(0, 12).map((p) => (
              <MenuItem
                key={p}
                icon={p === project ? <IconCheck size={13} /> : <IconFolder size={13} />}
                active={p === project}
                description={tildify(p, home)}
                onSelect={() => {
                  onPick(p)
                  setOpen(false)
                }}
              >
                {projectName(p)}
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<IconSparkle size={13} />}
            description="Not tied to a folder — for questions and quick tasks"
            onSelect={() => {
              onPick(chatsDir)
              setOpen(false)
            }}
          >
            General chat
          </MenuItem>
          <MenuItem
            icon={<IconPlus size={13} />}
            description="Or drop a folder anywhere on the window"
            onSelect={() => {
              setOpen(false)
              void addProject().then((dir) => dir && onPick(dir))
            }}
          >
            Open a folder…
          </MenuItem>
        </div>
      </Popover>
    </div>
  )
}

interface MentionItem {
  id: string
  label: string
  value: string
}

/** The "@" menu: files and folders in the project. */
function MentionMenu({ items, index, onHover, onPick }: { items: MentionItem[]; index: number; onHover: (i: number) => void; onPick: (item: MentionItem) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const maxHeight = useFitAbove(box, list, 256, items)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index, items])
  return (
    <div ref={box} className="anim-pop absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[var(--pop-shadow)]" role="listbox" aria-label="Files">
      <div ref={list} className="scroll-y p-1" style={{ maxHeight }}>
        {items.map((it, i) => (
          <div
            key={it.id}
            role="option"
            aria-selected={i === index}
            data-index={i}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(it)
            }}
            className={`flex items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] ${i === index ? 'bg-hover text-fg' : 'text-fg-2'}`}
          >
            <span className="shrink-0 font-mono text-[12px]">{it.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Composer({ mode, meta, project, onPickProject, autoFocusKey }: ComposerProps) {
  const settings = useApp((s) => s.settings)
  const providers = useApp((s) => s.providers)
  const homeProvider = useApp((s) => s.homeProvider)
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
  const [modelSignal, setModelSignal] = useState(0)
  const [effortSignal, setEffortSignal] = useState(0)

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
  const fastTier = provider === 'codex' ? modelInfo?.fastTier : undefined

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

  // The agent's own commands and skills (cached per agent).
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

  const inChat = !!meta
  const commandEntries = useMemo(() => {
    if (popup?.kind !== 'slash') return []
    const all = [...DUET_COMMANDS.filter((c) => (!c.only || c.only === provider) && (!c.inChat || inChat)), ...agentCommands(provider, commands[provider] ?? [])]
    // Agent entries named like a Duet command lose (Duet's version knows about the whole chat).
    const seen = new Set<string>()
    const unique = all.filter((c) => {
      const id = `${c.kind === 'skill' ? 'skill' : 'cmd'}:${c.name}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    return rankCommands(unique, popup.query)
  }, [popup, provider, commands, inChat])

  const fileItems = useMemo(() => (popup?.kind === 'mention' ? files.map((f) => ({ id: f.path, label: f.path + (f.isDir ? '/' : ''), value: `@${f.path}${f.isDir ? '/' : ''} ` })) : []), [popup, files])
  const popupCount = popup?.kind === 'slash' ? commandEntries.length : fileItems.length

  useEffect(() => setPopupIndex(0), [popup?.kind, popup?.query])

  const insertAtPopup = (value: string) => {
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

  /** Runs a command Duet handles itself. Returns true when it did something. */
  const runDuet = async (name: string, args: string): Promise<boolean> => {
    switch (name) {
      case 'theme':
        if (!args) setView('customize')
        else await designTheme(args)
        return true
      case 'new':
      case 'clear':
        goHome(cwd || null)
        return true
      case 'fork':
        if (meta) await forkThread(meta.id)
        else toast('Start the chat first, then fork it.', 'info')
        return true
      case 'claude':
      case 'codex':
        await switchProvider(name)
        return true
      case 'model':
        setModelSignal((n) => n + 1)
        return true
      case 'effort': {
        const levels = modelInfo?.efforts ?? []
        const wanted = args.toLowerCase()
        if (!wanted) setEffortSignal((n) => n + 1)
        else if (wanted === 'auto' || wanted === 'default') onPickEffort(undefined)
        else {
          const match = levels.find((l) => l === wanted || (EFFORT_LABEL[l] ?? '').toLowerCase() === wanted)
          if (match) onPickEffort(match)
          else toast(`${PROVIDER_LABEL[provider]} offers: auto, ${levels.join(', ') || 'no effort levels'}.`, 'info')
        }
        return true
      }
      case 'plan':
      case 'ask':
      case 'auto':
      case 'full-access':
        await setAccess(ACCESS_COMMAND[name])
        return true
      case 'fast':
        if (!meta) toast('Fast mode is set per chat — start the chat first.', 'info')
        else if (!fastTier) toast(`${modelInfo?.label ?? 'This model'} has no Fast mode.`, 'info')
        else {
          await updateThread(meta.id, { fast: !meta.fast })
          toast(meta.fast ? 'Fast mode off.' : `Fast mode on — ${fastTier.description || 'faster, uses more of your limits'}.`, 'info')
        }
        return true
      case 'usage':
      case 'customize':
        setView(name)
        return true
      case 'sync':
        await syncAllChats()
        return true
      case 'terminal':
        useApp.setState({ terminalOpen: true })
        return true
      case 'browser':
        openBrowser()
        return true
      case 'export':
        if (meta) await copyMarkdown(meta.id)
        else toast('Nothing to export yet — this chat is empty.', 'info')
        return true
      case 'help':
        update({ text: '/' })
        setPopup({ kind: 'slash', query: '', start: 0 })
        return true
      default:
        return false
    }
  }

  const pickCommand = (entry: CommandEntry) => {
    if (entry.kind === 'skill') {
      if (!entry.path) return
      const skills = [...(draft.skills ?? []).filter((s) => s.name !== entry.name), { name: entry.name, path: entry.path }]
      update({ text: draft.text.replace(/^\/[\w:.-]*/, '').trimStart(), skills })
      setPopup(null)
      textareaRef.current?.focus()
      return
    }
    if (entry.needsArgs || entry.argumentHint || entry.kind === 'send') {
      insertAtPopup(`/${entry.name} `)
      return
    }
    // Commands without arguments run straight away.
    setPopup(null)
    clearDraft(key)
    void runCommand(entry.name, '', entry)
  }

  /** Runs `/name args`; false means it isn't a command and should be sent as a message. */
  const runCommand = async (name: string, args: string, entry?: CommandEntry): Promise<boolean> => {
    if (DUET_COMMANDS.some((c) => c.name === name && (!c.only || c.only === provider))) return runDuet(name, args)
    if (provider !== 'codex') return false
    const known = entry ?? agentCommands('codex', commands.codex ?? []).find((c) => c.name === name && c.kind === 'run')
    if (name === 'review') {
      await sendCommandMessage(`/review${args ? ` ${args}` : ''}`, reviewTarget(args))
      return true
    }
    if (name === 'compact') {
      if (meta) await compactThread(meta.id)
      else toast('Nothing to compact yet — this chat is empty.', 'info')
      return true
    }
    if (name === 'init' && known?.prompt) {
      await sendCommandMessage(known.prompt)
      return true
    }
    return false
  }

  const sendCommandMessage = async (text: string, review?: ReviewTarget) => {
    if (mode === 'home') {
      const dir = project ?? (onPickProject ? await onPickProject() : null)
      if (dir) await createAndSend(dir, provider, { text, attachments: [] }, model, review)
    } else if (meta) await sendMessage(meta.id, { text, attachments: [] }, review)
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
    const command = parseCommand(text)
    if (command && draft.attachments.length === 0) {
      const snapshot = draft
      clearDraft(key)
      setPopup(null)
      try {
        if (await runCommand(command.name, command.args)) return
      } catch (error) {
        setDraft(key, snapshot)
        toastError(error)
        return
      }
      setDraft(key, snapshot) // not a Duet command: send it to the agent as typed
    }
    if (running && meta) {
      // The agent is busy: queue it and send automatically when the turn ends.
      queueMessage(meta.id, { text, attachments: draft.attachments, skills: draft.skills })
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
        await createAndSend(dir, provider, { text, attachments: snapshot.attachments, skills: snapshot.skills }, model)
      } else if (meta) {
        await sendMessage(meta.id, { text, attachments: snapshot.attachments, skills: snapshot.skills })
      }
    } catch (error) {
      setDraft(key, snapshot)
      toastError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup && popupCount) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPopupIndex((i) => (i + 1) % popupCount)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPopupIndex((i) => (i - 1 + popupCount) % popupCount)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const i = Math.min(popupIndex, popupCount - 1)
        if (popup.kind === 'slash') pickCommand(commandEntries[i])
        else insertAtPopup(fileItems[i].value)
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

  function onPickEffort(value: string | undefined) {
    if (mode === 'thread' && meta) void updateThread(meta.id, { efforts: { [provider]: value } })
    else if (settings) void saveSettings({ defaultEfforts: { ...settings.defaultEfforts, [provider]: value } })
  }

  const openCommands = () => {
    update({ text: draft.text.startsWith('/') ? draft.text : `/${draft.text}` })
    setPopup({ kind: 'slash', query: '', start: 0 })
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      ta?.focus()
      ta?.setSelectionRange(1, 1)
    })
  }

  const canSend = (draft.text.trim().length > 0 || draft.attachments.length > 0) && !busy
  const placeholder = running ? `${PROVIDER_LABEL[provider]} is working… type to queue a follow-up, Esc to stop` : mode === 'home' ? `Ask ${PROVIDER_LABEL[provider]} anything — / for commands, @ for files` : `Message ${PROVIDER_LABEL[provider]} — / for commands`

  return (
    <div className="relative">
      {meta && approvals.length > 0 && <ApprovalPanel threadId={meta.id} approvals={approvals} />}
      {popup?.kind === 'slash' && (
        <CommandMenu
          entries={commandEntries}
          index={popupIndex}
          onHover={setPopupIndex}
          onPick={pickCommand}
          provider={provider}
          grouped={!popup.query}
          loading={!commands[provider]}
        />
      )}
      {popup?.kind === 'mention' && fileItems.length > 0 && <MentionMenu items={fileItems} index={popupIndex} onHover={setPopupIndex} onPick={(it) => insertAtPopup(it.value)} />}
      <div
        className={`@container/composer relative z-[2] rounded-3xl border bg-surface shadow-[var(--composer-shadow)] transition-[border-color,box-shadow] duration-300 ${
          dragging ? 'border-accent ring-accent' : running ? 'composer-live border-line-strong' : 'border-line-strong focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--border-strong))]'
        }`}
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
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] text-[13px] font-medium text-accent">
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
                setDraft(key, { text: [queued.text, draft.text].filter(Boolean).join('\n\n'), attachments: [...queued.attachments, ...draft.attachments], skills: queued.skills ?? draft.skills })
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
        {(draft.attachments.length > 0 || (draft.skills?.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-end gap-2 px-3 pt-3">
            {(draft.skills ?? []).map((s) => (
              <span key={s.name} className="anim-pop flex h-7 items-center gap-1.5 rounded-full bg-accent/12 pl-2.5 pr-1 text-[12px] text-accent ring-1 ring-accent/30" data-testid="skill-chip">
                <IconSparkle size={12} />
                {s.name}
                <button type="button" aria-label={`Remove skill ${s.name}`} onClick={() => update({ skills: (draft.skills ?? []).filter((x) => x.name !== s.name) })} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-accent/20">
                  <IconX size={10} />
                </button>
              </span>
            ))}
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
            const pasted = Array.from(e.clipboardData.files)
            if (pasted.length) {
              e.preventDefault()
              void addAttachments(pasted)
            }
          }}
          className="block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[0.97em] leading-relaxed text-fg outline-none placeholder:text-fg-3"
        />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <IconButton label="Attach files or images" onClick={() => void pickFiles()}>
            <IconPaperclip size={16} />
          </IconButton>
          <IconButton label="Commands" shortcut="/" onClick={openCommands} data-testid="commands-button">
            <IconSlash size={16} />
          </IconButton>
          <ProviderSwitch value={provider} statuses={providers} onChange={(p) => void switchProvider(p)} />
          <div className="ml-1 flex min-w-0 items-center gap-0.5">
            <ModelMenu provider={provider} model={model} statuses={providers} onPick={onPickModel} openSignal={modelSignal} />
            <EffortMenu efforts={modelInfo?.efforts ?? []} value={effort} defaultEffort={modelInfo?.defaultEffort} hints={modelInfo?.effortHints} onPick={onPickEffort} openSignal={effortSignal} />
            <AccessMenu value={access} onPick={(a) => void setAccess(a)} />
            {fastTier && meta && (
              <Tooltip label={meta.fast ? `${fastTier.name} mode on — click to turn off` : `${fastTier.name} mode: ${fastTier.description || 'faster, uses more of your limits'}`}>
                <button
                  type="button"
                  aria-pressed={!!meta.fast}
                  onClick={() => void updateThread(meta.id, { fast: !meta.fast })}
                  className={`press flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium ${meta.fast ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:bg-hover hover:text-fg-2'}`}
                  data-testid="fast-toggle"
                >
                  <IconBolt size={13} />
                  <span className="hidden @[700px]/composer:inline">{fastTier.name}</span>
                </button>
              </Tooltip>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {meta?.context && <ContextRing used={meta.context.usedTokens} total={meta.context.windowTokens} />}
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
              <button type="button" aria-label="Stop" onClick={() => void stopThread(meta.id)} data-testid="stop-button" className="press flex h-8 w-8 items-center justify-center rounded-full bg-fg text-bg hover:opacity-90">
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
      {mode === 'home' && (
        <div className="mt-2 flex items-center justify-between gap-3 px-2 text-[11.5px] text-fg-3">
          <ProjectPicker project={project ?? null} onPick={(dir) => goHome(dir)} />
          <span className="hidden shrink-0 items-center gap-1 sm:flex">
            <Kbd>/</Kbd> commands <Kbd>@</Kbd> files <Kbd>⌘1</Kbd> <Kbd>⌘2</Kbd> switch agent
          </span>
        </div>
      )}
    </div>
  )
}
