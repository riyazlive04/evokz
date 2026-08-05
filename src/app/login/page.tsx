import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/app/login/LoginForm';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Sign in — Evokz ACE',
  // The console is not a public product surface; keep it out of search results
  // even though the gateway lock means a crawler could never reach past here.
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * The one route `middleware.ts` does not guard, so it verifies the session
 * itself — otherwise an operator who is already signed in would sit on a login
 * form with no indication that their session is fine.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const destination = safeDestination(searchParams.next);

  const secret = process.env.SESSION_SECRET ?? '';
  const token = cookies().get(SESSION_COOKIE)?.value;

  if (await verifySessionToken(token, secret)) {
    redirect(destination);
  }

  const configured = Boolean(secret) && Boolean(process.env.ADMIN_PASSWORD_HASH);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Evokz ACE</CardTitle>
          <CardDescription>
            {configured
              ? 'Sign in to reach the creative console.'
              : 'This deployment has no console password configured.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {configured ? (
            <LoginForm next={destination} />
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Set <code className="font-mono">SESSION_SECRET</code> and{' '}
              <code className="font-mono">ADMIN_PASSWORD_HASH</code> in the
              environment, then restart. Generate both with{' '}
              <code className="font-mono">node scripts/hash-password.mjs</code>.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * Confines the post-login redirect to this origin.
 *
 * `next` arrives from the query string, so an unchecked value makes this an open
 * redirect — a phishing link could send an operator through a real sign-in and
 * out to an attacker's page. Only a single-slash-prefixed path is accepted;
 * `//evil.tld` is protocol-relative and would leave the site.
 */
function safeDestination(candidate: string | undefined): string {
  if (!candidate) return '/admin/dashboard';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/admin/dashboard';
  return candidate;
}
