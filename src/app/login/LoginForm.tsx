'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { KeyRound, Loader2 } from 'lucide-react';

import { login } from '@/app/login/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

/**
 * The console sign-in form.
 *
 * On success the server action has already written the session cookie, so the
 * client only has to navigate. `router.replace` keeps the login page out of
 * history — a back-press after signing in should not land on it — and
 * `router.refresh` discards the RSC payload cached for the anonymous visit, so
 * the destination renders against the new session rather than a 401 snapshot.
 */
export function LoginForm({ next }: { next: string }) {
  const signIn = useAction(login);
  const router = useRouter();
  const [submitted, setSubmitted] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    const result = await signIn.run(formData);
    if (!result.ok) return;

    // Held true through the navigation: clearing `pending` before the new route
    // paints would flash an idle "Sign in" button on a login that worked.
    setSubmitted(true);
    router.replace(next);
    router.refresh();
  }

  const busy = signIn.pending || submitted;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">Console password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          disabled={busy}
          aria-invalid={signIn.error ? true : undefined}
          aria-describedby={signIn.error ? 'login-error' : undefined}
        />
      </div>

      {signIn.error && (
        <p id="login-error" role="alert" className="text-xs text-danger-ink">
          {signIn.error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
