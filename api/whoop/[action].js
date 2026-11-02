// Vercel Function: dezelfde proxy als server/whoop-proxy.mjs, op /api/whoop/login|callback|refresh|data.
// Zet in Vercel: WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET en APP_URL (bv. https://whoop-amber.vercel.app/).
import { handle } from '../../server/whoop-proxy.mjs';

const env = () => ({
  WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET: process.env.WHOOP_CLIENT_SECRET,
  APP_URL: process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/` : undefined),
  REDIRECT_URI: process.env.REDIRECT_URI,
});

export const GET = (request) => handle(request, env());
export const POST = (request) => handle(request, env());
export const OPTIONS = (request) => handle(request, env());
