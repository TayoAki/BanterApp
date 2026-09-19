/**
 * Public client configuration. Only EXPO_PUBLIC_* values are bundled; none
 * of them is a privileged secret.
 */
export const env = {
  name: process.env['EXPO_PUBLIC_ENV'] ?? 'development',
  apiBaseUrl: (process.env['EXPO_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8787').replace(/\/$/, ''),
  supabaseUrl: process.env['EXPO_PUBLIC_SUPABASE_URL'] ?? '',
  supabasePublishableKey: process.env['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ?? '',
  revenueCatIosKey: process.env['EXPO_PUBLIC_REVENUECAT_IOS_KEY'] ?? '',
  revenueCatAndroidKey: process.env['EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'] ?? '',
} as const;

export const supabaseConfigured = env.supabaseUrl.length > 0 && env.supabasePublishableKey.length > 0;
