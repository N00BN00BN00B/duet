import { useEffect, useMemo, useState } from 'react'
import type { AccentMode, ChatWidth, Density, PersonalityPreset, ProviderId, ThemePref } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { normalizeTheme, PRESET_THEMES, THEME_EFFECTS, THEME_FONTS, type ThemeEffect, type ThemeFont, type ThemeSpec } from '@shared/theme'
import { PERSONALITIES } from '@shared/personality'
import { duet } from '@/lib/api'
import { chooseTheme, deleteCustomTheme, designTheme, previewTheme, saveSettings, toast, toastError, useApp } from '@/state/store'
import { ThemeSwatch } from '../BackgroundEffect'
import { ProviderLogo } from '../brand'
import { IconCheck, IconMonitor, IconMoon, IconPencil, IconSmile, IconSparkle, IconSun, IconTrash, IconWand, Spinner } from '../icons'
import { Button, ColorField, Segmented, Slider, Switch, inputClass } from '../ui/primitives'
import { Card, Page, Row, Section } from './Page'

const IDEAS = ['Dark gradient with a wave effect', 'Calm paper light theme', 'Neon synthwave grid', 'Deep space with stars', 'Forest green, soft and rounded', 'Monochrome, sharp corners']

function ThemeCard({ theme, active, onPick, onEdit, onDelete }: { theme: ThemeSpec; active: boolean; onPick: () => void; onEdit?: () => void; onDelete?: () => void }) {
  return (
    <div className={`group/theme relative rounded-xl p-1 transition-[box-shadow,transform] duration-200 ${active ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:-translate-y-0.5 hover:ring-line-strong'}`} data-testid="theme-card">
      <button type="button" onClick={onPick} className="block w-full text-left" aria-label={`Use ${theme.name}`}>
        <ThemeSwatch theme={theme} className="h-[74px] w-full rounded-lg" />
        <span className="flex items-center gap-1.5 px-1 pb-0.5 pt-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{theme.name}</span>
          {theme.background.effect !== 'none' && <span className="text-[10.5px] text-fg-3">{THEME_EFFECTS.find((e) => e.id === theme.background.effect)?.label}</span>}
          {active && <IconCheck size={12} className="text-accent" />}
        </span>
      </button>
      {(onEdit || onDelete) && (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/theme:opacity-100">
          {onEdit && (
            <button type="button" aria-label={`Edit ${theme.name}`} onClick={onEdit} className="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white hover:bg-black/70">
              <IconPencil size={12} />
            </button>
          )}
          {onDelete && (
            <button type="button" aria-label={`Delete ${theme.name}`} onClick={onDelete} className="flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white hover:bg-black/70">
              <IconTrash size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Designs a theme from words: an agent when one is connected, offline otherwise. */
function DescribeLook() {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [via, setVia] = useState<ProviderId | 'auto'>('auto')
  const providers = useApp((s) => s.providers)
  const go = async (text = prompt) => {
    if (!text.trim() || busy) return
    setBusy(true)
    const theme = await designTheme(text, via === 'auto' ? undefined : via)
    setBusy(false)
    if (theme) setPrompt('')
  }
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
        <IconWand size={15} className="text-accent" /> Describe a look
      </div>
      <div className="flex items-center gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
          placeholder="e.g. dark gradient with a wave effect"
          className={`${inputClass} h-9 flex-1 text-[13px]`}
          data-testid="theme-prompt"
        />
        <Button variant="accent" disabled={!prompt.trim() || busy} onClick={() => void go()} icon={busy ? <Spinner size={13} /> : <IconSparkle size={13} />} data-testid="theme-generate">
          {busy ? 'Designing…' : 'Make it'}
        </Button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {IDEAS.map((idea) => (
          <button key={idea} type="button" disabled={busy} onClick={() => void go(idea)} className="press rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-fg-3 hover:border-line-strong hover:text-fg-2 disabled:opacity-50">
            {idea}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-fg-3">
          Designed by
          <select value={via} onChange={(e) => setVia(e.target.value as ProviderId | 'auto')} className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-fg-2 outline-none">
            <option value="auto">your default agent</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p} disabled={!providers[p]?.installed}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </span>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-fg-3">Also works from any chat: type <span className="font-mono text-fg-2">/theme</span> and what you want. The agent only picks colours and an effect, so a theme can never change how Duet works.</p>
    </Card>
  )
}

function ThemeEditor({ theme, onClose }: { theme: ThemeSpec; onClose: () => void }) {
  const [draft, setDraft] = useState<ThemeSpec>(theme)
  useEffect(() => {
    previewTheme(draft)
  }, [draft])
  useEffect(() => () => previewTheme(null), [])
  const edit = (patch: Record<string, unknown>) => {
    const changed = (patch.colors ?? {}) as Record<string, string>
    const colors: Record<string, string> = { ...draft.colors, ...changed }
    // Shades that follow from the background / text are worked out again when those change.
    if (changed.bg) for (const k of ['sidebar', 'surface', 'fg2', 'fg3']) if (!(k in changed)) delete colors[k]
    if (changed.fg) for (const k of ['fg2', 'fg3']) delete colors[k]
    const next = normalizeTheme({ ...draft, ...patch, colors, background: { ...draft.background, ...((patch.background as object) ?? {}) } }, draft.id)
    if (next) setDraft({ ...next, source: draft.source === 'preset' ? 'custom' : draft.source, prompt: draft.prompt })
  }
  const fx = draft.background
  return (
    <Card className="p-4" data-testid="theme-editor">
      <div className="mb-3 flex items-center gap-2">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.slice(0, 40) })} className={`${inputClass} h-8 max-w-[240px] font-medium`} aria-label="Theme name" />
        <Segmented size="sm" value={draft.base} onChange={(v) => edit({ base: v })} options={[{ value: 'dark', label: 'Dark', icon: <IconMoon size={11} /> }, { value: 'light', label: 'Light', icon: <IconSun size={11} /> }]} />
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="accent"
            onClick={async () => {
              await chooseTheme({ ...draft, name: draft.name.trim() || 'Custom theme', source: draft.source === 'preset' ? 'custom' : draft.source })
              onClose()
            }}
          >
            Save theme
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {(['bg', 'sidebar', 'surface', 'fg', 'accent'] as const).map((key) => (
          <ColorField key={key} label={{ bg: 'Background', sidebar: 'Sidebar', surface: 'Cards', fg: 'Text', accent: 'Accent' }[key]} value={draft.colors[key]} onChange={(v) => edit({ colors: { [key]: v } })} />
        ))}
      </div>
      <div className="mt-4">
        <div className="mb-2 text-[12px] font-medium text-fg-2">Background effect</div>
        <div className="flex flex-wrap gap-1.5">
          {THEME_EFFECTS.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => edit({ background: { effect: e.id as ThemeEffect }, glass: e.id === 'none' ? 0 : Math.max(draft.glass, 0.35) })}
              className={`press rounded-full px-3 py-1 text-[12px] ${fx.effect === e.id ? 'bg-accent text-white' : 'bg-surface-2 text-fg-2 ring-1 ring-line hover:text-fg'}`}
            >
              {e.label}
            </button>
          ))}
        </div>
        {fx.effect !== 'none' && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="flex flex-wrap gap-2">
              {fx.colors.slice(0, 3).map((c, i) => (
                <div key={i} className="w-[150px]">
                  <ColorField label={`Effect colour ${i + 1}`} value={c} onChange={(v) => edit({ background: { colors: fx.colors.map((x, j) => (j === i ? v : x)) } })} />
                </div>
              ))}
              {fx.colors.length < 3 && (
                <Button size="sm" variant="ghost" onClick={() => edit({ background: { colors: [...fx.colors, draft.colors.accent] } })}>
                  + colour
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              <Slider label="Strength" value={fx.intensity} min={0} max={1} onChange={(v) => edit({ background: { intensity: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Speed" value={fx.speed} min={0} max={2} onChange={(v) => edit({ background: { speed: v } })} format={(v) => (v === 0 ? 'still' : `${v.toFixed(1)}×`)} />
              <Slider label="See-through" value={draft.glass} min={0} max={1} onChange={(v) => edit({ glass: v })} format={(v) => `${Math.round(v * 100)}%`} />
              {(fx.effect === 'gradient' || fx.effect === 'wave' || fx.effect === 'noise') && <Slider label="Angle" value={fx.angle} min={0} max={360} step={5} onChange={(v) => edit({ background: { angle: v } })} format={(v) => `${Math.round(v)}°`} />}
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Slider label="Roundness" value={draft.radius} min={0.4} max={1.6} onChange={(v) => edit({ radius: v })} format={(v) => `${v.toFixed(1)}×`} />
        <div className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-[12px] text-fg-2">Font</span>
          <Segmented<ThemeFont> size="sm" value={draft.font} onChange={(v) => edit({ font: v })} options={THEME_FONTS.map((f) => ({ value: f.id, label: <span style={{ fontFamily: f.stack }}>{f.label}</span> }))} />
        </div>
      </div>
    </Card>
  )
}

function PersonalityCard() {
  const settings = useApp((s) => s.settings)
  const [custom, setCustom] = useState(settings?.personality.custom ?? '')
  const [importing, setImporting] = useState(false)
  if (!settings) return null
  const p = settings.personality
  const save = (patch: Partial<typeof p>) => void saveSettings({ personality: { ...p, ...patch } })
  return (
    <Card>
      <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-3">
        {PERSONALITIES.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => save({ preset: x.id as PersonalityPreset, importedFrom: undefined })}
            className={`press rounded-xl px-3 py-2.5 text-left transition-colors ${p.preset === x.id ? 'bg-accent/10 ring-1 ring-accent/40' : 'bg-surface-2 ring-1 ring-line hover:ring-line-strong'}`}
            data-testid={`personality-${x.id}`}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              {x.label}
              {p.preset === x.id && <IconCheck size={12} className="text-accent" />}
            </span>
            <span className="mt-0.5 block text-[11.5px] text-fg-3">{x.description}</span>
          </button>
        ))}
      </div>
      {p.preset === 'custom' && (
        <div className="border-t border-line p-3">
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onBlur={() => custom !== p.custom && save({ custom })}
            rows={4}
            placeholder="How should the agents talk to you? e.g. “Short answers, British spelling, explain risky changes before making them.”"
            className={`${inputClass} h-auto resize-y py-2 text-[12.5px] leading-relaxed`}
            data-testid="personality-custom"
          />
        </div>
      )}
      <Row>
        <span className="flex-1 text-[12.5px] text-fg-2">Use it with</span>
        {PROVIDERS.map((id) => (
          <label key={id} className="flex items-center gap-2 text-[12.5px]">
            <ProviderLogo provider={id} size={12} /> {PROVIDER_LABEL[id]}
            <Switch checked={p.providers.includes(id)} onChange={(on) => save({ providers: on ? [...new Set([...p.providers, id])] : p.providers.filter((x) => x !== id) })} label={`Personality for ${PROVIDER_LABEL[id]}`} />
          </label>
        ))}
      </Row>
      <Row>
        <div className="flex-1">
          <div className="text-[12.5px] text-fg-2">{p.importedFrom ? `Imported from ${p.importedFrom}` : 'Use the output style you picked in Claude Code'}</div>
          <div className="text-[11.5px] text-fg-3">Applies to new chats; a running conversation keeps the style it started with.</div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={importing ? <Spinner size={13} /> : <IconSmile size={13} />}
          onClick={async () => {
            setImporting(true)
            try {
              const found = await duet.personality.importFromClaude()
              if (!found) toast("Couldn't find Claude Code's output style.", 'info')
              else {
                setCustom(found.custom)
                // Claude already speaks this way, so it's Codex that needs it.
                await saveSettings({ personality: { preset: found.preset, custom: found.custom, providers: ['codex'], importedFrom: found.label } })
                toast(`Codex now uses ${found.label}.`, 'success')
              }
            } catch (error) {
              toastError(error)
            } finally {
              setImporting(false)
            }
          }}
          data-testid="personality-import"
        >
          Import from Claude Code
        </Button>
      </Row>
    </Card>
  )
}

export function CustomizeView() {
  const settings = useApp((s) => s.settings)
  const current = useApp((s) => s.theme)
  const [editing, setEditing] = useState<ThemeSpec | null>(null)
  const themes = useMemo(() => [...PRESET_THEMES, ...(settings?.customThemes ?? [])], [settings?.customThemes])
  if (!settings) return null
  return (
    <Page title="Customize" testId="customize-view" subtitle="Make Duet yours: themes, colours, background effects, layout and how the agents talk to you.">
      <Section title="Theme">
        <DescribeLook />
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {themes.map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              active={current.id === t.id}
              onPick={() => void chooseTheme(t)}
              onEdit={() => setEditing({ ...t, id: t.source === 'preset' ? `${t.id}-custom-${Date.now().toString(36)}` : t.id, name: t.source === 'preset' ? `${t.name} (mine)` : t.name, source: t.source === 'preset' ? 'custom' : t.source })}
              onDelete={t.source !== 'preset' ? () => void deleteCustomTheme(t.id) : undefined}
            />
          ))}
        </div>
        {editing && (
          <div className="mt-3">
            <ThemeEditor key={editing.id} theme={editing} onClose={() => setEditing(null)} />
          </div>
        )}
      </Section>

      <Section title="Appearance">
        <Card>
          <Row>
            <div className="flex-1 text-[13px]">Mode</div>
            <div className="w-[260px] max-w-full">
              <Segmented<ThemePref>
                value={settings.theme}
                onChange={(v) => void saveSettings({ theme: v })}
                options={[
                  { value: 'system', label: 'System', icon: <IconMonitor size={12} /> },
                  { value: 'dark', label: 'Dark', icon: <IconMoon size={12} /> },
                  { value: 'light', label: 'Light', icon: <IconSun size={12} /> }
                ]}
              />
            </div>
          </Row>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Accent colour</div>
              <div className="text-[11.5px] text-fg-3">Agent: terracotta for Claude, periwinkle for Codex, so you always know who's answering.</div>
            </div>
            <div className="w-[260px] max-w-full">
              <Segmented<AccentMode> size="sm" value={settings.accentMode} onChange={(v) => void saveSettings({ accentMode: v })} options={[{ value: 'agent', label: 'Agent' }, { value: 'theme', label: 'Theme' }, { value: 'custom', label: 'Custom' }]} />
            </div>
            {settings.accentMode === 'custom' && (
              <div className="w-[150px]">
                <ColorField label="Accent" value={settings.accentColor} onChange={(v) => void saveSettings({ accentColor: v })} />
              </div>
            )}
          </Row>
          <Row>
            <div className="flex-1 text-[13px]">Text size</div>
            <div className="w-[260px] max-w-full">
              <Segmented value={String(settings.fontSize)} onChange={(v) => void saveSettings({ fontSize: Number(v) })} options={['13', '14', '15', '16'].map((v) => ({ value: v, label: `${v}px` }))} />
            </div>
          </Row>
          <Row>
            <div className="flex-1 text-[13px]">Density</div>
            <div className="w-[260px] max-w-full">
              <Segmented<Density> size="sm" value={settings.density} onChange={(v) => void saveSettings({ density: v })} options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]} />
            </div>
          </Row>
          <Row>
            <div className="flex-1 text-[13px]">Chat width</div>
            <div className="w-[260px] max-w-full">
              <Segmented<ChatWidth> size="sm" value={settings.chatWidth} onChange={(v) => void saveSettings({ chatWidth: v })} options={[{ value: 'narrow', label: 'Narrow' }, { value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }]} />
            </div>
          </Row>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Background effects</div>
              <div className="text-[11.5px] text-fg-3">Waves, aurora and the like. They pause whenever Duet is in the background.</div>
            </div>
            <Switch checked={settings.backgroundEffects} onChange={(v) => void saveSettings({ backgroundEffects: v })} label="Background effects" />
          </Row>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Reduce motion</div>
              <div className="text-[11.5px] text-fg-3">Turns off animations everywhere.</div>
            </div>
            <Switch checked={settings.reduceMotion} onChange={(v) => void saveSettings({ reduceMotion: v })} label="Reduce motion" />
          </Row>
        </Card>
      </Section>

      <Section title="Sidebar & chat">
        <Card>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Agent names in the sidebar</div>
              <div className="text-[11.5px] text-fg-3">Shows “Claude ·” or “Codex ·” before each chat's title.</div>
            </div>
            <Switch checked={settings.sidebarAgentNames} onChange={(v) => void saveSettings({ sidebarAgentNames: v })} label="Agent names in the sidebar" />
          </Row>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Reply details</div>
              <div className="text-[11.5px] text-fg-3">Time, tokens and cost under each reply.</div>
            </div>
            <Switch checked={settings.showTurnDetails} onChange={(v) => void saveSettings({ showTurnDetails: v })} label="Reply details" />
          </Row>
        </Card>
      </Section>

      <Section title="Personality" description="How both agents talk to you. Duet adds it to each agent's instructions; nothing about what they're allowed to do changes.">
        <PersonalityCard />
      </Section>
    </Page>
  )
}

