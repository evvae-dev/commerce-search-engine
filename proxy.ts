import { NextRequest, NextResponse } from 'next/server';

import { CORS_ALLOW_ORIGIN } from './constant/api.constant';

const allowedMethods = 'GET, POST, OPTIONS';
const allowedHeaders = 'Content-Type, Authorization';

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith('/api/v1/admin') || pathname.startsWith('/api/auth')) {
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, { status: 405 });
    }
    return NextResponse.next();
  }

  const headers = {
    'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': allowedMethods,
    'Access-Control-Allow-Headers': allowedHeaders,
  };

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers });
  }

  const response = NextResponse.next();
  Object.entries(headers).forEach(([name, value]) => {
    response.headers.set(name, value);
  });
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
