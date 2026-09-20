/**
 * Public client configuration. Only EXPO_PUBLIC_* values are bundled; none
 * of them is a privileged secret.
 */
export const env = {
  name: process.env['EXPO_PUBLIC_ENV'] ?? 'development',
  apiBaseUrl: (process.env['EXPO_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8787').replace(/\/$/, ''),
  /** `password`: email + password accounts served by the API. `fixture`: local development identities against a fixture server. */
  authMode: (process.env['EXPO_PUBLIC_AUTH_MODE'] === 'fixture' ? 'fixture' : 'password') as 'password' | 'fixture',
  revenueCatIosKey: process.env['EXPO_PUBLIC_REVENUECAT_IOS_KEY'] ?? '',
  revenueCatAndroidKey: process.env['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'] ?? '',
} as const;

/** Development identities are only honored by a non-production server and are never offered in production builds. */
export const fixtureSignInAvailable = env.authMode === 'fixture' && env.name !== 'production';
