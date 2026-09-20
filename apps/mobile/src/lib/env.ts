import Constants from 'expo-constants';

/**
 * Public client configuration. Only EXPO_PUBLIC_* values and the `extra`
 * block of app.json are bundled; none of them is a privileged secret.
 *
 * Resolution order for the API base URL: EXPO_PUBLIC_API_BASE_URL (a local
 * .env for development against a LAN server) → app.json `extra.apiBaseUrl`
 * (the deployed Railway API, committed) → localhost.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as { apiBaseUrl?: unknown; authMode?: unknown };

const apiBaseUrl = process.env['EXPO_PUBLIC_API_BASE_URL'] || (typeof extra.apiBaseUrl === 'string' ? extra.apiBaseUrl : '') || 'http://localhost:8787';
const authMode = process.env['EXPO_PUBLIC_AUTH_MODE'] || (typeof extra.authMode === 'string' ? extra.authMode : '') || 'password';

export const env = {
  name: process.env['EXPO_PUBLIC_ENV'] ?? 'development',
  apiBaseUrl: apiBaseUrl.replace(/\/$/, ''),
  /** `password`: email + password accounts served by the API. `fixture`: local development identities against a fixture server. */
  authMode: (authMode === 'fixture' ? 'fixture' : 'password') as 'password' | 'fixture',
  revenueCatIosKey: process.env['EXPO_PUBLIC_REVENUECAT_IOS_KEY'] ?? '',
  revenueCatAndroidKey: process.env['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'] ?? '',
} as const;

/** Development identities are only honored by a non-production server and are never offered in production builds. */
export const fixtureSignInAvailable = env.authMode === 'fixture' && env.name !== 'production';
