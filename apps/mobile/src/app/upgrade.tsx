import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Loading, Pill, Screen } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { newClientKey } from '../lib/keys';
import { configurePurchases, loadMonthlyOffer, managementUrl, purchase, purchasesConfigured, restore, type OfferSummary } from '../lib/purchases';
import { queryClient } from '../lib/query';
import { track } from '../lib/telemetry';

type OfferState = { kind: 'loading' } | { kind: 'unavailable'; reason: string } | { kind: 'ready'; offer: OfferSummary };

/**
 * One app-wide Pro plan. Price, period and currency come from the store via
 * RevenueCat; nothing is invented. Access is granted only after the server
 * reconciles the purchase with the provider.
 */
export default function Upgrade() {
  const router = useRouter();
  const { userId } = useAuth();
  const entitlement = useQuery({ queryKey: ['entitlements'], queryFn: api.entitlements });
  const [offer, setOffer] = useState<OfferState>({ kind: 'loading' });
  const [status, setStatus] = useState<'idle' | 'pending' | 'canceled' | 'active' | 'failed'>('idle');

  useEffect(() => {
    track('offer_viewed');
    (async () => {
      if (!purchasesConfigured()) {
        setOffer({ kind: 'unavailable', reason: 'Store billing isn’t configured for this build.' });
        return;
      }
      try {
        if (userId) await configurePurchases(userId);
        const o = await loadMonthlyOffer();
        setOffer(o ? { kind: 'ready', offer: o } : { kind: 'unavailable', reason: 'The Pro product isn’t available in your store right now.' });
      } catch {
        setOffer({ kind: 'unavailable', reason: 'Couldn’t load store products.' });
      }
    })();
  }, [userId]);

  const reconcile = async () => {
    const result = await api.restoreEntitlements({ client_key: newClientKey('restore') });
    await queryClient.invalidateQueries({ queryKey: ['entitlements'] });
    await queryClient.invalidateQueries({ queryKey: ['today'] });
    return result;
  };

  const buy = useMutation({
    mutationFn: async () => {
      if (offer.kind !== 'ready') throw new Error('unavailable');
      setStatus('pending');
      const { cancelled } = await purchase(offer.offer.pkg);
      if (cancelled) {
        setStatus('canceled');
        return null;
      }
      const ent = await reconcile();
      setStatus(ent.plan === 'pro' ? 'active' : 'pending');
      return ent;
    },
    onError: () => setStatus('failed'),
  });
  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (purchasesConfigured()) await restore();
      return reconcile();
    },
  });
  const manage = async () => {
    try {
      const url = purchasesConfigured() ? await managementUrl() : null;
      if (url) await Linking.openURL(url);
    } catch {
      // no-op
    }
  };

  const plan = entitlement.data?.plan ?? 'free';

  return (
    <Screen>
      <Gap />
      <Eyebrow>Pro practice</Eyebrow>
      <Heading>More reps when you want them.</Heading>
      <Card>
        <Label>Free</Label>
        <Body>All approved framework explanations, lessons, progress, and one voice practice session per UTC day.</Body>
      </Card>
      <Card tone="lavender">
        <Label style={{ fontWeight: '600' }}>Pro (monthly)</Label>
        <Body>Ten voice practice sessions per UTC day plus mixed-skill practice. A session includes one recording, one transcript correction, one guided retry, one rewrite per evaluated attempt, and one generated playback per rewrite.</Body>
        {offer.kind === 'loading' ? <Loading label="Loading store price" /> : null}
        {offer.kind === 'unavailable' ? <Label>{offer.reason}</Label> : null}
        {offer.kind === 'ready' ? (
          <Body style={{ fontWeight: '700' }}>
            {offer.offer.priceString} · {offer.offer.period === 'P1M' ? 'per month' : offer.offer.period} · {offer.offer.title}
          </Body>
        ) : null}
        <Label>Exact price, period and renewal terms are shown by the store at checkout. Extra practice beyond the daily cap is a clear limit, not unlimited use.</Label>
      </Card>

      {plan === 'pro' ? <Pill tone="success">Pro is active on this account</Pill> : entitlement.data?.state === 'pending' ? <Pill tone="accent">Purchase pending verification</Pill> : null}
      {status === 'canceled' ? <Label>Purchase canceled. Nothing was charged.</Label> : null}
      {status === 'pending' && !buy.isPending ? <Label>We’re verifying your purchase with the store. Access updates as soon as it’s confirmed.</Label> : null}
      {status === 'failed' ? <ErrorBox message="The purchase didn’t complete. If you were charged, use Restore purchases." /> : null}

      {plan !== 'pro' ? <Button title="Buy Pro" onPress={() => buy.mutate()} loading={buy.isPending} disabled={offer.kind !== 'ready'} /> : null}
      <Button title="Restore purchases" variant="secondary" onPress={() => restoreMutation.mutate()} loading={restoreMutation.isPending} />
      {restoreMutation.isSuccess ? <Label>{restoreMutation.data.plan === 'pro' ? 'Pro restored.' : 'No active Pro purchase was found for this account.'}</Label> : null}
      <Button title="Manage subscription" variant="ghost" onPress={manage} />
      <Label>A purchase made on another account doesn’t unlock this one. Subscription renewals are managed by the store, separately from account deletion.</Label>
      <Button title="Back" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
