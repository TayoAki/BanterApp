/** Design tokens from handoff/design/tokens.json. */
export const colors = {
  canvas: '#F7F5EF',
  surface: '#FFFFFF',
  ink: '#17243A',
  muted: '#526077',
  primary: '#4B36C1',
  lavender: '#EEE9FF',
  accent: '#F6C857',
  success: '#176448',
  error: '#AF2435',
  border: '#E6E1F5',
} as const;

export const fontSizes = { body: 17, label: 14, heading: 28, score: 44 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { card: 16, button: 12 } as const;
export const minTouch = 48;
export const contentMaxWidth = 520;
export const motionMs = 180;

export const brand = {
  name: 'marshmemos',
  tagline: 'A little practice. A little more you.',
} as const;
