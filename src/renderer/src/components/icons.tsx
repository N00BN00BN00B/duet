import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, strokeWidth = 1.75, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
)
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0l.1.6a1.7 1.7 0 0 0 2.5 1.1l.5-.3a1.7 1.7 0 0 1 2.4 2.4l-.3.5a1.7 1.7 0 0 0 1.1 2.5l.6.1a1.7 1.7 0 0 1 0 3.4l-.6.1a1.7 1.7 0 0 0-1.1 2.5l.3.5a1.7 1.7 0 0 1-2.4 2.4l-.5-.3a1.7 1.7 0 0 0-2.5 1.1l-.1.6a1.7 1.7 0 0 1-3.4 0l-.1-.6a1.7 1.7 0 0 0-2.5-1.1l-.5.3a1.7 1.7 0 0 1-2.4-2.4l.3-.5a1.7 1.7 0 0 0-1.1-2.5l-.6-.1a1.7 1.7 0 0 1 0-3.4l.6-.1a1.7 1.7 0 0 0 1.1-2.5l-.3-.5a1.7 1.7 0 0 1 2.4-2.4l.5.3a1.7 1.7 0 0 0 2.5-1.1z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Svg>
)
export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 18.5 6.2 11a1.6 1.6 0 0 1 1.5-1.1h12.6a1 1 0 0 1 1 1.3l-2 6.7a1.6 1.6 0 0 1-1.5 1.1H5.5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.6l2 2h5.4a2 2 0 0 1 2 2v.9" />
  </Svg>
)
export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12.2c0 4-3.6 7.3-8 7.3-1.3 0-2.5-.3-3.6-.8L4 20l1.2-3.7A6.9 6.9 0 0 1 4 12.2C4 8.3 7.6 5 12 5s8 3.3 8 7.2z" />
  </Svg>
)
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
  </Svg>
)
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.3 3.4 5.1 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.1-3.4-8.5S9.7 5.8 12 3.5z" />
  </Svg>
)
export const IconDiff = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="6" r="2.2" />
    <circle cx="17.5" cy="18" r="2.2" />
    <path d="M6.5 8.2V14a4 4 0 0 0 4 4h4.8M17.5 15.8V10a4 4 0 0 0-4-4H8.7" />
  </Svg>
)
export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />
  </Svg>
)
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d="m19.5 11.4-7.2 7.2a4.6 4.6 0 0 1-6.5-6.5l7.6-7.6a3.1 3.1 0 0 1 4.4 4.4l-7.6 7.6a1.5 1.5 0 0 1-2.2-2.2l6.9-6.9" />
  </Svg>
)
export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="9.8" r="1.6" />
    <path d="m20.5 15.5-4.6-4.6L6 19.5" />
  </Svg>
)
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
)
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
)
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
  </Svg>
)
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 6.5 9 12l5.5 5.5" />
  </Svg>
)
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
)
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
  </Svg>
)
export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5.5M11 6.5 5.5 12l5.5 5.5" />
  </Svg>
)
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" />
  </Svg>
)
export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v3.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10" />
  </Svg>
)
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7M6.5 7l.8 11.1a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7M10.2 11v5M13.8 11v5" />
  </Svg>
)
export const IconArchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5" />
    <path d="M5 9v8.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </Svg>
)
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4.5h6M10 4.5v5.3L6.8 13v1.5h10.4V13L14 9.8V4.5M12 14.5v5" />
  </Svg>
)
export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
    <path d="M4.5 4.5V9H9M12 8v4.3l2.8 1.7" />
  </Svg>
)
export const IconPlug = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v4M15 4v4M7 8h10v3a5 5 0 0 1-10 0zM12 16v4" />
  </Svg>
)
export const IconSync = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 9.5A7.5 7.5 0 0 1 18 7.2L19.5 9M19.5 4.5V9H15M19.5 14.5A7.5 7.5 0 0 1 6 16.8L4.5 15M4.5 19.5V15H9" />
  </Svg>
)
export const IconBackup = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
    <path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" />
  </Svg>
)
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.8 5.5 6.3v5.4c0 4 2.7 7.3 6.5 8.5 3.8-1.2 6.5-4.5 6.5-8.5V6.3z" />
  </Svg>
)
export const IconShieldCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.8 5.5 6.3v5.4c0 4 2.7 7.3 6.5 8.5 3.8-1.2 6.5-4.5 6.5-8.5V6.3z" />
    <path d="m9 12 2.2 2.2L15.3 10" />
  </Svg>
)
export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0" />
    <path d="m12 13.5 3.5-4M12 13.5h.01" />
  </Svg>
)
export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z" />
  </Svg>
)
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 4.6a2 2 0 0 1 3.4 0l7 12.2a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3z" />
    <path d="M12 9.5v4M12 16.8h.01" />
  </Svg>
)
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 7.8h.01" />
  </Svg>
)
export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="7" cy="18.5" r="2" />
    <circle cx="17" cy="7.5" r="2" />
    <path d="M7 7.5v9M17 9.5c0 4-4.5 3.5-8.6 7.5" />
  </Svg>
)
export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5z" />
    <path d="M13.5 3.5v5h5" />
  </Svg>
)
export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15.2 5.3 3.5 3.5M4.5 19.5l1-4.4L16.3 4.3a1.7 1.7 0 0 1 2.4 0l1 1a1.7 1.7 0 0 1 0 2.4L8.9 18.5z" />
  </Svg>
)
export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
)
export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9.5 4.5v15" />
  </Svg>
)
export const IconPanelRight = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M14.5 4.5v15" />
  </Svg>
)
export const IconPanelBottom = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M3.5 14.5h17" />
  </Svg>
)
export const IconCrosshair = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 8.5V6.5a1.5 1.5 0 0 1 1.5-1.5h2M15.5 5h2A1.5 1.5 0 0 1 19 6.5v2M19 15.5v2a1.5 1.5 0 0 1-1.5 1.5h-2M8.5 19h-2A1.5 1.5 0 0 1 5 17.5v-2" />
    <path d="m10 10 6.5 2.4-2.7 1.3-1.3 2.7z" />
  </Svg>
)
export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 8.5a2 2 0 0 1 2-2h1.8l1.4-2h4.6l1.4 2h1.8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.8" r="3.2" />
  </Svg>
)
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5a7.5 7.5 0 1 0 9.7 9.7z" />
  </Svg>
)
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.8" />
    <path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7 18 18M18 6l-1.3 1.3M7.3 16.7 6 18" />
  </Svg>
)
export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
)
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconCommand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 9V6.8A2.3 2.3 0 1 0 6.8 9H9zm0 0h6m-6 0v6m6-6V6.8A2.3 2.3 0 1 1 17.2 9H15zm0 0v6m0 0h2.2a2.3 2.3 0 1 1-2.2 2.2V15zm0 0H9m0 0v2.2A2.3 2.3 0 1 1 6.8 15H9z" />
  </Svg>
)
export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5zM18.5 15.5c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3z" />
  </Svg>
)
export const IconListChecks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 6.5 1.5 1.5L8.5 5M4 12.5 5.5 14l3-3M4 18.5 5.5 20l3-3M11.5 6.5h8.5M11.5 12.5h8.5M11.5 18.5h8.5" />
  </Svg>
)
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8 10.5V8a4 4 0 1 1 8 0v2.5" />
  </Svg>
)
export const IconUnlock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8 10.5V8a4 4 0 0 1 7.7-1.5" />
  </Svg>
)
export const IconHand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 12.5V5.8a1.4 1.4 0 0 1 2.8 0v5.7M11.3 11V4.4a1.4 1.4 0 0 1 2.8 0V11M14.1 11V5.6a1.4 1.4 0 0 1 2.8 0v7.6c0 4-2.4 6.8-6.1 6.8-2.3 0-3.8-1-5-2.8l-2.2-3.4a1.4 1.4 0 0 1 2.2-1.8l1.7 1.8" />
  </Svg>
)
export const IconMap = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 5-5 2v12.5l5-2 6 2 5-2V5l-5 2zM9 5v12.5M15 7v12.5" />
  </Svg>
)
export const IconWrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0 5.2 5.2l-8.6 8.6a2.1 2.1 0 0 1-3-3l8.6-8.6a4 4 0 0 1-2.2-2.2z" />
  </Svg>
)
export const IconBot = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="8" width="15" height="11" rx="3" />
    <path d="M12 8V4.5M9.2 13h.01M14.8 13h.01M9.5 16h5" />
  </Svg>
)
export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />
  </Svg>
)
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
  </Svg>
)
export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15.5v-11M7 9l5-5 5 5M5 19.5h14" />
  </Svg>
)
export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 10.5 12 4.5l7.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-3.5v-5.5h-5V20H6a1.5 1.5 0 0 1-1.5-1.5z" />
  </Svg>
)
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
)
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.9.9M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.9-.9" />
  </Svg>
)
export const IconForkThread = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="17.5" cy="5.5" r="2" />
    <circle cx="12" cy="18.5" r="2" />
    <path d="M6.5 7.5v1.8a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3V7.5M12 12.3v4.2" />
  </Svg>
)
export const IconSwitch = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 8.5h13l-3.5-3.5M19.5 15.5h-13l3.5 3.5" />
  </Svg>
)
export const IconKeyboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M7.5 14h9" />
  </Svg>
)
export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 4 8.5 4.5L12 13 3.5 8.5z" />
    <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
  </Svg>
)
export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l10-6.5z" />
  </Svg>
)
export const IconDot = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </Svg>
)

/** Small ring spinner that inherits the current color. */
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`spin ${className}`} aria-label="Working">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
