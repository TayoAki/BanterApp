import { Redirect } from 'expo-router';
import { useAuth } from '../lib/auth';
import { Loading, Screen } from '../components/ui';

export default function Index() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <Screen scroll={false}>
        <Loading label="Loading" />
      </Screen>
    );
  }
  return <Redirect href={status === 'signed_in' ? '/(tabs)/today' : '/welcome'} />;
}
