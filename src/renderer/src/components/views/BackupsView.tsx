import { useCallback, useEffect, useState } from 'react'
import type { BackupInfo, BackupSet } from '@shared/types'
import { duet } from '@/lib/api'
import { formatBytes, formatDate, timeAgo, tildify } from '@/lib/format'
import { saveSettings, toast, toastError, useApp } from '@/state/store'
import { IconBackup, IconDownload, IconFolder, IconRefresh, IconTrash, IconUpload, IconWarning, Spinner } from '../icons'
import { Button, Chip, Dialog, EmptyState, IconButton, Meter, Segmented, Switch } from '../ui/primitives'
import { Card, Page, Section } from './Page'

const SET_LABEL: Record<string, string> = {
  'claude-config': 'Claude settings',
  'claude-sessions': 'Claude chats',
  'codex-config': 'Codex settings',
  'codex-sessions': 'Codex chats',
  'codex-app-state': 'Codex app DBs',
  'codex-auth': 'Codex login',
  duet: 'Duet'
}

export function BackupsView() {
  const settings = useApp((s) => s.settings)
  const progress = useApp((s) => s.backupProgress)
  const home = useApp((s) => s.info.home)
  const [sets, setSets] = useState<BackupSet[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)
  const [restoreSets, setRestoreSets] = useState<string[]>([])
  const [busyRestore, setBusyRestore] = useState(false)
  const [deleting, setDeleting] = useState<BackupInfo | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([duet.backup.sets(), duet.backup.list()])
      setSets(s)
      setSelected((prev) => (prev.length ? prev.filter((id) => s.some((x) => x.id === id)) : s.filter((x) => x.defaultOn).map((x) => x.id)))
      setBackups(b)
    } catch (e) {
      toastError(e)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const total = (sets ?? []).filter((s) => selected.includes(s.id)).reduce((n, s) => n + (s.bytes ?? 0), 0)

  const create = async () => {
    setCreating(true)
    try {
      const info = await duet.backup.create(selected)
      toast(`Backup saved (${formatBytes(info.bytes)})`, 'success')
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setCreating(false)
    }
  }

  const restore = async () => {
    if (!restoring) return
    setBusyRestore(true)
    try {
      const res = await duet.backup.restore(restoring.file, restoreSets)
      toast(
        `Restored ${res.restored} file${res.restored === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped — links or folders that lead outside Claude, Codex or Duet’s data)` : ''}. A safety backup of what was replaced is in your backup folder.`,
        'success'
      )
      if (restoreSets.includes('duet')) toast('Duet will restart to load the restored threads…', 'info')
      setRestoring(null)
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setBusyRestore(false)
    }
  }

  return (
    <Page
      title="Backups"
      testId="backups-view"
      subtitle="Snapshot everything Claude Code and Codex know — settings, skills, MCP servers and full conversation history — into one archive you can restore on this or another Mac. Keep the folder in iCloud Drive or Dropbox and your setup follows you."
      actions={
        <IconButton label="Refresh" onClick={() => void load()}>
          <IconRefresh size={15} />
        </IconButton>
      }
    >
      <Section title="Create a backup">
        <Card>
          {sets === null ? (
            <div className="flex justify-center py-10 text-fg-3">
              <Spinner size={18} />
            </div>
          ) : (
            sets.map((s) => {
              const on = selected.includes(s.id)
              return (
                <label key={s.id} className="flex min-h-[52px] cursor-default items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-hover/40" data-testid={`backup-set-${s.id}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setSelected((cur) => (on ? cur.filter((x) => x !== s.id) : [...cur, s.id]))}
                    className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      {s.label}
                      {s.sensitive && (
                        <Chip tone="warn">
                          <IconWarning size={10} /> contains login tokens
                        </Chip>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-fg-3">{s.description}</div>
                  </div>
                  <span className="shrink-0 text-right text-[11.5px] tabular-nums text-fg-3">
                    {s.files ? `${formatBytes(s.bytes ?? 0)} · ${s.files.toLocaleString()} files` : 'empty'}
                  </span>
                </label>
              )
            })
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2/40 px-4 py-3">
            <button type="button" onClick={() =>
                void duet.backup.chooseDir().then((dir) => {
                  if (dir) void saveSettings({ backupDir: dir })
                })
              } className="press flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg-2 hover:bg-hover hover:text-fg" title="Change backup folder">
              <IconFolder size={13} />
              <span className="max-w-[320px] truncate">{settings ? tildify(settings.backupDir, home) : ''}</span>
            </button>
            <span className="ml-auto text-[12px] tabular-nums text-fg-3">{formatBytes(total)} before compression</span>
            <Button variant="accent" size="sm" disabled={!selected.length || creating} onClick={() => void create()} icon={creating ? <Spinner size={13} /> : <IconDownload size={13} />} data-testid="backup-create">
              {creating ? 'Backing up…' : 'Back up now'}
            </Button>
          </div>
          {progress && (
            <div className="border-t border-line px-4 py-3">
              <div className="mb-1.5 flex justify-between text-[11.5px] text-fg-2">
                <span>{progress.phase}…</span>
                <span className="tabular-nums">
                  {formatBytes(progress.done)} / {formatBytes(progress.total)}
                </span>
              </div>
              <Meter value={progress.total ? (progress.done / progress.total) * 100 : 0} tone="accent" />
            </div>
          )}
        </Card>
      </Section>

      <Section title="Automatic backups" description="Duet backs up settings, skills, MCP servers and its own threads in the background while it's open. Conversation history is included in manual backups.">
        <Card>
          <div className="flex items-center gap-4 px-4 py-3">
            <span className="flex-1 text-[13px]">Schedule</span>
            <div className="w-[240px]">
              <Segmented
                size="sm"
                value={settings?.autoBackup ?? 'off'}
                onChange={(v) => void saveSettings({ autoBackup: v })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'daily', label: 'Daily' },
                  { value: 'weekly', label: 'Weekly' }
                ]}
              />
            </div>
          </div>
          <div className="flex items-center gap-4 border-t border-line px-4 py-3">
            <div className="flex-1">
              <div className="text-[13px]">Include Codex login</div>
              <div className="text-[11.5px] text-fg-3">Lets a restore sign you straight back in. Only enable this if your backup folder is private.</div>
            </div>
            <Switch checked={!!settings?.includeAuthInBackups} onChange={(v) => void saveSettings({ includeAuthInBackups: v })} label="Include Codex login" />
          </div>
          {settings?.lastAutoBackup && <div className="border-t border-line px-4 py-2 text-[11.5px] text-fg-3">Last automatic backup {timeAgo(settings.lastAutoBackup)} ago</div>}
        </Card>
      </Section>

      <Section title="Saved backups">
        {backups === null ? (
          <div className="flex justify-center py-10 text-fg-3">
            <Spinner size={18} />
          </div>
        ) : backups.length === 0 ? (
          <Card>
            <EmptyState icon={<IconBackup size={18} />} title="No backups yet">
              Your first backup will appear here.
            </EmptyState>
          </Card>
        ) : (
          <Card>
            {backups.map((b) => (
              <div key={b.file} className="group/b flex min-h-[56px] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0" data-testid="backup-row">
                <IconBackup size={16} className="shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    {formatDate(b.createdAt)}
                    {b.name.endsWith('-auto') && <Chip>auto</Chip>}
                    {b.name.endsWith('-before-restore') && <Chip tone="info">before restore</Chip>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {b.sets.map((s) => (
                      <Chip key={s}>{SET_LABEL[s] ?? s}</Chip>
                    ))}
                    <span className="text-[11px] text-fg-3">
                      {formatBytes(b.bytes)}
                      {b.files ? ` · ${b.files.toLocaleString()} files` : ''}
                      {b.host ? ` · ${b.host}` : ''}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton label="Show in Finder" onClick={() => void duet.app.reveal(b.file)}>
                    <IconFolder size={14} />
                  </IconButton>
                  <IconButton label="Move to Trash" onClick={() => setDeleting(b)}>
                    <IconTrash size={14} />
                  </IconButton>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconUpload size={13} />}
                    onClick={() => {
                      setRestoring(b)
                      setRestoreSets((b.sets.length ? b.sets : Object.keys(SET_LABEL)).filter((s) => s !== 'codex-auth'))
                    }}
                  >
                    Restore…
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Dialog
        open={!!restoring}
        onClose={() => !busyRestore && setRestoring(null)}
        title="Restore from backup"
        description="Pick what to bring back. Duet first saves a safety backup of the files it's about to replace, so a restore can always be undone."
        width={500}
        footer={
          <>
            <Button variant="ghost" disabled={busyRestore} onClick={() => setRestoring(null)}>
              Cancel
            </Button>
            <Button variant="accent" disabled={!restoreSets.length || busyRestore} onClick={() => void restore()} icon={busyRestore ? <Spinner size={13} /> : undefined}>
              Restore
            </Button>
          </>
        }
      >
        <div className="space-y-1.5 pb-1">
          {(restoring ? (restoring.sets.length ? restoring.sets : Object.keys(SET_LABEL)) : []).map((s) => {
            const on = restoreSets.includes(s)
            return (
              <label key={s} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
                <input type="checkbox" checked={on} onChange={() => setRestoreSets((cur) => (on ? cur.filter((x) => x !== s) : [...cur, s]))} className="h-4 w-4 accent-[var(--accent)]" />
                {SET_LABEL[s] ?? s}
              </label>
            )
          })}
          {restoring && restoring.sets.length === 0 && <div className="text-[12.5px] text-fg-2">This backup has no description file, so Duet restores whichever of these it finds inside.</div>}
          <div className="flex items-start gap-2 pt-2 text-[12px] leading-relaxed text-fg-2">
            <IconWarning size={14} className="mt-[2px] shrink-0 text-warn" />
            Quit Claude Code and the Codex app before restoring their data so nothing overwrites it afterwards.
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Move this backup to the Trash?"
        description={deleting ? `${formatDate(deleting.createdAt)} · ${formatBytes(deleting.bytes)}. You can still recover it from the Trash.` : ''}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const target = deleting
                setDeleting(null)
                if (!target) return
                try {
                  await duet.backup.remove(target.file)
                  await load()
                } catch (e) {
                  toastError(e)
                }
              }}
            >
              Move to Trash
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </Page>
  )
}
