// Which Catppuccin flavour the extension's pages wear.
//
// Kept in chrome.storage.local, next to the blocklist, rather than in IndexedDB: every
// page can read it without opening the database, and chrome.storage.onChanged lets a
// dashboard tab follow a change made on the options page without a reload.
//
// Only pages import this — the service worker has no DOM to paint.

const KEY = 'theme';

/** 'auto' defers to the OS, which the stylesheet's prefers-color-scheme block handles. */
export const THEMES = ['auto', 'latte', 'macchiato'];

// The stored values keep the Catppuccin flavour names, because that is what the
// stylesheet's [data-theme] selectors match on. Only the button says light and dark.
const LABELS = {
  auto: 'System',
  latte: 'Light',
  macchiato: 'Dark',
};

export async function getTheme() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return THEMES.includes(stored) ? stored : 'auto';
}

export async function setTheme(theme) {
  await chrome.storage.local.set({ [KEY]: theme });
}

function apply(theme) {
  // Absence of the attribute is what lets the media query decide, so 'auto' removes it
  // rather than setting a third value.
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Paint the stored theme and keep following it. Every page calls this; pages that also
 * offer the control pass their button to mountThemeToggle().
 */
export async function initTheme() {
  const theme = await getTheme();
  apply(theme);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const next = changes[KEY].newValue;
    apply(THEMES.includes(next) ? next : 'auto');
  });

  return theme;
}

/** Wire a button that cycles system → Latte → Macchiato. */
export async function mountThemeToggle(button) {
  let current = await getTheme();
  button.textContent = LABELS[current];

  button.addEventListener('click', async () => {
    current = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    button.textContent = LABELS[current];
    apply(current);
    await setTheme(current);
  });

  // initTheme() repaints on a change made in another tab; the label has to follow too,
  // or this page's button ends up naming a flavour it is no longer showing.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    current = THEMES.includes(changes[KEY].newValue) ? changes[KEY].newValue : 'auto';
    button.textContent = LABELS[current];
  });
}
