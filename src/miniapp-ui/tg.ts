// Telegram WebApp handle. Isolated so nothing else in the app has to
// null-check window.Telegram directly.

interface TelegramHapticFeedback {
  notificationOccurred(kind: "success" | "warning" | "error"): void;
}
interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor?: (c: string) => void;
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
  if (!tg) return;
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor?.("secondary_bg_color"); } catch { /* older clients */ }
}

export function haptic(kind: "success" | "warning" | "error"): void {
  try { tg?.HapticFeedback?.notificationOccurred(kind); } catch { /* not supported */ }
}

export function closeMiniApp(): void {
  tg?.close();
}
