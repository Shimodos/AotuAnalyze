import { NextResponse } from 'next/server';
import { isConfigured } from '@/dropbox/config';
import { getAccount, isConnected } from '@/dropbox/tokens';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const connected = isConnected();
    return NextResponse.json({
      configured: isConfigured(),
      connected,
      account: connected ? getAccount() : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
