'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

import { logout } from '@/app/login/actions';
import { Button } from '@/components/ui/button';

/**
 * Clears the session cookie and returns to the sign-in screen.
 *
 * `router.refresh()` after the push is not optional: the console's RSC payloads
 * are cached in the client router, so without it a back-press would re-paint a
 * fully rendered dashboard from memory. The data would be stale rather than
 * live — no request reaches the server — but it still shows client names and
 * spend to whoever is at the keyboard after the operator walks away.
 */
export function SignOutButton() {
  const [pending, setPending] = React.useState(false);
  const router = useRouter();

  async function handleSignOut() {
    setPending(true);
    await logout();
    router.replace('/login');
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void handleSignOut()}
      disabled={pending}
      title="Sign out of the console"
    >
      <LogOut className="h-4 w-4" />
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
