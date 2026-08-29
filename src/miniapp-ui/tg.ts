// Telegram WebApp handle. Isolated so nothing else in the app has to
// null-check window.Telegram directly.

interface TelegramHapticFeedback {
  notificationOccurred(kind: "success" | "warning" | "error"): void;
}
interface TelegramWebApp {
  initData: string;
  version?: string;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast?: (version: string) => boolean;
  isVerticalSwipesEnabled?: boolean;
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (c: string) => void;
  viewportHeight?: number;
  onEvent?: (eventType: "viewportChanged", eventHandler: () => void) => void;
  HapticFeedback?: TelegramHapticFeedback;
}
declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export const tg: TelegramWebApp | undefined = window.Telegram?.WebApp;
export const INIT_DATA: string = tg?.initData ?? "";

export function initTelegram(): void {
  syncAppViewportHeight();
  window.addEventListener("resize", syncAppViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("resize", syncAppViewportHeight, { passive: true });

  if (!tg) return;
  tg.ready();
  tg.expand();
  try {
    if (tg.disableVerticalSwipes && tg.isVersionAtLeast?.("7.7") !== false) {
      tg.disableVerticalSwipes();
    }
  } catch { /* older clients */ }
  try {
    if (tg.setHeaderColor && tg.isVersionAtLeast?.("6.1") !== false) {
      tg.setHeaderColor("secondary_bg_color");
    }
  } catch { /* older clients */ }
  try { tg.onEvent?.("viewportChanged", syncAppViewportHeight); } catch { /* older clients */ }
}

export function haptic(kind: "success" | "warning" | "error"): void {
  try { tg?.HapticFeedback?.notificationOccurred(kind); } catch { /* not supported */ }
}

export function closeMiniApp(): void {
  tg?.close();
}

function syncAppViewportHeight(): void {
  const height =
    (tg?.viewportHeight && tg.viewportHeight > 0 ? tg.viewportHeight : 0)
    || window.visualViewport?.height
    || window.innerHeight;
  if (!height || !Number.isFinite(height)) return;
  document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
}
