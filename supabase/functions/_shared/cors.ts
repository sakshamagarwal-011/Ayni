// Shared CORS headers for MeetSync 3D Edge Functions.
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Typed JSON error. `code` is a stable machine-readable code from the
 * coordination error catalogue (see COORDINATION.md) so the frontend
 * can branch on it; it is optional for backward compatibility.
 */
export function jsonError(message: string, status = 400, code?: string): Response {
  return jsonResponse(code ? { error: message, code } : { error: message }, status);
}
