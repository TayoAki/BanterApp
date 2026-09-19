import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL, type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';
import { env } from './env';

/**
 * Native store billing via RevenueCat. The customer is bound to the stable
 * signed-in user id before any purchase; the server still decides access by
 * reconciling with the provider. Nothing here grants Pro on its own.
 */
export function purchasesConfigured(): boolean {
  return (Platform.OS === 'ios' && env.revenueCatIosKey.length > 0) || (Platform.OS === 'android' && env.revenueCatAndroidKey.length > 0);
}

let configuredFor: string | null = null;

export async function configurePurchases(userId: string): Promise<boolean> {
  if (!purchasesConfigured()) return false;
  const apiKey = Platform.OS === 'ios' ? env.revenueCatIosKey : env.revenueCatAndroidKey;
  if (configuredFor === userId) return true;
  if (configuredFor === null) {
    await Purchases.setLogLevel(env.name === 'production' ? LOG_LEVEL.ERROR : LOG_LEVEL.INFO);
    Purchases.configure({ apiKey, appUserID: userId });
  } else {
    await Purchases.logIn(userId);
  }
  configuredFor = userId;
  return true;
}

export async function resetPurchasesIdentity(): Promise<void> {
  if (!configuredFor) return;
  try {
    await Purchases.logOut();
  } catch {
    // anonymous already
  }
  configuredFor = null;
}

export interface OfferSummary {
  pkg: PurchasesPackage;
  title: string;
  priceString: string;
  period: string;
}

export async function loadMonthlyOffer(): Promise<OfferSummary | null> {
  const offerings = await Purchases.getOfferings();
  const pkg = offerings.current?.monthly ?? offerings.current?.availablePackages[0] ?? null;
  if (!pkg) return null;
  return {
    pkg,
    title: pkg.product.title,
    priceString: pkg.product.priceString,
    period: pkg.product.subscriptionPeriod ?? 'P1M',
  };
}

export async function purchase(pkg: PurchasesPackage): Promise<{ customerInfo: CustomerInfo; cancelled: boolean }> {
  try {
    const result = await Purchases.purchasePackage(pkg);
    return { customerInfo: result.customerInfo, cancelled: false };
  } catch (err) {
    const e = err as { userCancelled?: boolean };
    if (e.userCancelled) {
      return { customerInfo: await Purchases.getCustomerInfo(), cancelled: true };
    }
    throw err;
  }
}

export async function restore(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

export async function managementUrl(): Promise<string | null> {
  const info = await Purchases.getCustomerInfo();
  return info.managementURL;
}
