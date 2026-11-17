import { NextResponse } from 'next/server';
import { isConfigured } from '@/dropbox/config';
import { getAccount, isConnected } from '@/dropbox/tokens';
import { errorMessage, jsonError } from '@/server/http';

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
    return jsonError(errorMessage(error), 500);
  }
}
