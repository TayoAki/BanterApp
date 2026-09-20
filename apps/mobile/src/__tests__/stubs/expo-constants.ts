/** Node test stand-in for expo-constants: no app.json extras, so env.ts falls back to its defaults. */
const Constants = { expoConfig: null as { extra?: Record<string, unknown> } | null };
export default Constants;
