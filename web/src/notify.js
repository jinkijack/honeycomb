/**
 * System notifications.
 *
 * Tasks take minutes; staring at the tab wastes attention. The Notifications API
 * works on localhost without HTTPS, so this needs no Electron.
 *
 * Permission is only requested in response to a click — browsers ignore (or
 * penalize) automatic requests on page load.
 */

const KEY = 'honeycomb.notify';

export function isEnabled() {
  return localStorage.getItem(KEY) === '1' && Notification?.permission === 'granted';
}

export function isSupported() {
  return typeof Notification !== 'undefined';
}

export function permission() {
  return isSupported() ? Notification.permission : 'unsupported';
}

export async function enable() {
  if (!isSupported()) return false;
  const perm = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (perm !== 'granted') return false;
  localStorage.setItem(KEY, '1');
  return true;
}

export function disable() {
  localStorage.removeItem(KEY);
}

export function notify(title, { body, tag, onClick } = {}) {
  if (!isEnabled()) return;
  // if the tab is already visible, the notification would only duplicate it
  if (document.visibilityState === 'visible') return;

  try {
    const n = new Notification(title, { body, tag, icon: undefined });
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
        n.close();
      };
    }
  } catch {
    // the browser may refuse in specific contexts; not a reason to break
  }
}
